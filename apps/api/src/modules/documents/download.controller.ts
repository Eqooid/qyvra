import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';
import { DownloadService } from './download.service';

/** @description Authenticated binary response; explicit Express response handling bypasses JSON success serialization. */
@ApiTags('Documents')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard)
@Controller('documents')
export class DownloadController {
  constructor(private readonly downloads: DownloadService) {}
  @Get(':documentId/download')
  @ApiParam({ name: 'documentId', type: String, format: 'uuid' })
  @ApiOperation({
    summary: 'Download the current original file',
    description:
      'Highest versionNumber only; archived allowed, deleted/DELETING unavailable. No query/body parameters or client-selected version. Range ignored: full 200 attachment, private no-store.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Streamed attachment with Content-Length, safe ASCII/Unicode Content-Disposition, nosniff and private no-store. No JSON envelope.',
    content: Object.fromEntries(
      ['application/pdf', 'image/jpeg', 'image/png'].map((mime) => [
        mime,
        { schema: { type: 'string', format: 'binary' } },
      ]),
    ),
  })
  @ApiBadRequestResponse({
    description: 'Invalid UUID or unsupported request input.',
  })
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse({
    description: 'Missing, unowned, deleted or DELETING document.',
  })
  @ApiConflictResponse({
    description: 'No current version or ambiguous current version.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Missing object, invalid stored metadata or unavailable storage/database. Early errors use the standard envelope; late read failures terminate the connection.',
  })
  async download(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (
      Object.keys(request.query).length ||
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0
    )
      throw new BadRequestException();
    await this.downloads.send(user.id, id, response);
  }
}
