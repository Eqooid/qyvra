import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { documentStatuses } from './document-lifecycle';
import { documentSorts, DocumentSort } from './document-pagination';

/**
 * @author Cristono Wijaya
 * @description Validates that a string is a valid calendar date in the format YYYY-MM-DD.
 * @param value - The value to validate.
 * @returns True if the value is a valid calendar date, false otherwise.
 * @tags Documents
 */
export function isCalendarDate(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith('0000')
  )
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/**
 * @author Cristono Wijaya
 * @description Custom validation decorators for optional and nullable fields, as well as trimming string values.
 * @tags Documents
 */
const optional = (_object: unknown, value: unknown) => value !== undefined;
const nullable = (_object: unknown, value: unknown) =>
  value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimNullableDescription = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;
const calendar = () =>
  ValidateBy({ name: 'calendarDate', validator: { validate: isCalendarDate } });

/**
 * @author Cristono Wijaya
 * @description Whitelists mutable document metadata. Omission preserves values; nullable fields can be cleared.
 * @tags Documents
 */
export class UpdateDocumentDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @ValidateIf(nullable)
  @Transform(trimNullableDescription)
  @IsString()
  @MaxLength(2000)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare description?: string | null;

  /**
   * @author Cristono Wijaya
   * @description The title of the document. Must be a non-empty string with a maximum length of 300 characters.
   * @tags Documents
   * @optional
   * @nullable
   * @example "My Document Title"
   * @maxLength 300
   * @pattern "^[^\u0000-\u001f\u007f]+$"
   * @validation IsString, IsNotEmpty, MaxLength, Matches
   * @transform trim
   */
  @ApiPropertyOptional({ minLength: 1, maxLength: 300 })
  @ValidateIf(optional)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare title?: string;
  @ApiPropertyOptional({
    maxLength: 50,
    example: 'WARRANTY',
    pattern: '^[A-Z][A-Z0-9_]{0,49}$',
  })

  /**
   * @author Cristono Wijaya
   * @description The type of the document. Must be an uppercase string starting with a letter, followed by letters, numbers, or underscores, with a maximum length of 50 characters.
   * @tags Documents
   * @optional
   * @pattern "^[A-Z][A-Z0-9_]{0,49}$"
   * @validation Matches
   */
  @ApiPropertyOptional({
    maxLength: 50,
    example: 'WARRANTY',
    pattern: '^[A-Z][A-Z0-9_]{0,49}$',
  })
  @ValidateIf(optional)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,49}$/)
  declare documentType?: string;

  /**
   * @author Cristono Wijaya
   * @description The issuer of the document. Must be a non-empty string with a maximum length of 200 characters.
   * @tags Documents
   * @optional
   * @nullable
   * @example "Company Inc."
   * @maxLength 200
   * @pattern "^[^\u0000-\u001f\u007f]+$"
   * @validation IsString, IsNotEmpty, MaxLength, Matches
   * @transform trim
   */
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf(nullable)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare issuer?: string | null;

  /**
   * @author Cristono Wijaya
   * @description The reference number of the document. Must be a non-empty string with a maximum length of 200 characters.
   * @tags Documents
   * @optional
   * @nullable
   * @example "REF-12345"
   * @maxLength 200
   * @pattern "^[^\u0000-\u001f\u007f]+$"
   * @validation IsString, IsNotEmpty, MaxLength, Matches
   * @transform trim
   */
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf(nullable)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare referenceNumber?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date',
    example: '2026-01-01',
  })

  /**
   * @author Cristono Wijaya
   * @description The date of the document. Must be a valid calendar date in the format YYYY-MM-DD.
   * @tags Documents
   * @optional
   * @nullable
   * @example "2026-01-01"
   * @format "date"
   * @validation ValidateBy (isCalendarDate)
   */
  @ValidateIf(nullable)
  @calendar()
  declare documentDate?: string | null;

  /**
   * @author Cristono Wijaya
   * @description The expiration date of the document. Must be a valid calendar date in the format YYYY-MM-DD.
   * @tags Documents
   * @optional
   * @nullable
   * @example "2026-12-31"
   * @format "date"
   * @validation ValidateBy (isCalendarDate)
   */
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' })
  @ValidateIf(nullable)
  @calendar()
  declare expirationDate?: string | null;

  /**
   * @author Cristono Wijaya
   * @description The ID of the category associated with the document. Must be a valid UUID.
   * @tags Documents
   * @optional
   * @nullable
   * @format "uuid"
   * @validation IsUUID
   */
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @ValidateIf(nullable)
  @IsUUID()
  declare categoryId?: string | null;

  /**
   * @author Cristono Wijaya
   * @description The IDs of the tags associated with the document. Must be an array of valid UUIDs, with a maximum of 100 items. Duplicate IDs will be removed.
   * @tags Documents
   * @optional
   * @nullable
   * @type [String]
   * @maxItems 100
   * @format "uuid"
   * @validation IsArray, ArrayMaxSize, IsUUID (each)
   * @transform Deduplicate and lowercase each ID
   */
  @ApiPropertyOptional({
    type: [String],
    maxItems: 100,
    description: 'UUIDs; deduplicated. [] clears tags; null is invalid.',
  })
  @ValidateIf(optional)
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? [
          ...new Set(
            value.map((id: unknown) =>
              typeof id === 'string' ? id.toLowerCase() : id,
            ),
          ),
        ]
      : value,
  )
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  declare tagIds?: string[];
}

/**
 * @author Cristono Wijaya
 * @description Explicit filter/sort allowlist with a timestamp/UUID cursor; never accepts arbitrary Prisma fields.
 * @tags Documents
 */
export class DocumentListQuery {
  /**
   * @author Cristono Wijaya
   * @description The maximum number of documents to return in the list. Must be an integer between 1 and 100. Defaults to 25.
   * @tags Documents
   * @optional
   * @type Number
   * @default 25
   * @minimum 1
   * @maximum 100
   * @validation IsInt, Min, Max
   * @transform Convert string to number if applicable
   */
  @ApiPropertyOptional({ type: Number, default: 25, minimum: 1, maximum: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  /**
   * @author Cristono Wijaya
   * @description An allow-listed document sort; a leading minus means descending. Defaults to '-createdAt'.
   * @tags Documents
   * @optional
   * @enum ['-createdAt', 'createdAt', '-updatedAt', 'title', '-title', '-fileSize']
   * @default '-createdAt'
   * @validation IsIn
   */
  @ApiPropertyOptional({
    enum: [...documentSorts],
    default: '-createdAt',
  })
  @IsIn(documentSorts)
  sort: DocumentSort = '-createdAt';

  /**
   * @author Cristono Wijaya
   * @description The cursor for pagination. Must be a base64url-encoded string with a maximum length of 4096 characters. Used to fetch the next page of results based on the preceding page's cursor.
   * @tags Documents
   * @optional
   * @type String
   * @maxLength 4096
   * @pattern "^[A-Za-z0-9_-]+$"
   * @validation IsString, MaxLength, Matches
   */
  @ApiPropertyOptional({
    maxLength: 4096,
    description:
      'Opaque cursor from the preceding page using the same filters/order.',
  })
  @ValidateIf(optional)
  @IsString()
  @MaxLength(4096)
  @Matches(/^[A-Za-z0-9_-]+$/)
  declare cursor?: string;

  /**
   * @author Cristono Wijaya
   * @description The search query for filtering documents. Must be a non-empty string with a maximum length of 200 characters. Used to perform a case-insensitive substring search on the title, issuer, and reference fields of the documents.
   * @tags Documents
   * @optional
   * @type String
   * @maxLength 200
   * @pattern "^[^\u0000-\u001f\u007f]+$"
   * @validation IsString, IsNotEmpty, MaxLength, Matches
   * @transform trim
   */
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Literal case-insensitive title/issuer/reference substring.',
  })
  @ValidateIf(optional)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare q?: string;

  /**
   * @author Cristono Wijaya
   * @description The status filter for the document list. Must be one of the predefined document statuses. Used to filter documents based on their lifecycle status.
   * @tags Documents
   * @optional
   * @enum [...documentStatuses]
   * @validation IsIn
   */
  @ApiPropertyOptional({ enum: [...documentStatuses] })
  @ValidateIf(optional)
  @IsIn(documentStatuses)
  declare status?: string;

  /**
   * @author Cristono Wijaya
   * @description The type of the document. Must be an uppercase string starting with a letter, followed by letters, numbers, or underscores, with a maximum length of 50 characters.
   * @tags Documents
   * @optional
   * @pattern "^[A-Z][A-Z0-9_]{0,49}$"
   * @validation Matches
   */
  @ApiPropertyOptional({ pattern: '^[A-Z][A-Z0-9_]{0,49}$' })
  @ValidateIf(optional)
  @Matches(/^[A-Z][A-Z0-9_]{0,49}$/)
  declare documentType?: string;

  /**
   * @author Cristono Wijaya
   * @description The ID of the category associated with the document. Must be a valid UUID.
   * @tags Documents
   * @optional
   * @format "uuid"
   * @validation IsUUID
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf(optional)
  @IsUUID()
  declare categoryId?: string;

  /**
   * @author Cristono Wijaya
   * @description The ID of the tag associated with the document. Must be a valid UUID.
   * @tags Documents
   * @optional
   * @format "uuid"
   * @validation IsUUID
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf(optional)
  @IsUUID()
  declare tagId?: string;

  @ApiPropertyOptional({
    type: String,
    description:
      'Comma-separated list of 1–10 distinct owned tag UUIDs; all must match. Cannot accompany tagId.',
  })
  @ValidateIf(optional)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.split(',').map((id) => id.toLowerCase())
      : null,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  declare tagIds?: string[];

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Literal case-insensitive substring of current originalFilename.',
  })
  @ValidateIf(optional)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  declare filename?: string;

  @ApiPropertyOptional({ enum: ['application/pdf', 'image/jpeg', 'image/png'] })
  @ValidateIf(optional)
  @IsIn(['application/pdf', 'image/jpeg', 'image/png'])
  declare mimeType?: 'application/pdf' | 'image/jpeg' | 'image/png';

  @ApiPropertyOptional({
    format: 'date',
    description: 'Inclusive UTC calendar day on document createdAt.',
  })
  @ValidateIf(optional)
  @calendar()
  declare createdFrom?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Inclusive UTC calendar day on document createdAt.',
  })
  @ValidateIf(optional)
  @calendar()
  declare createdTo?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Inclusive UTC calendar day on document updatedAt.',
  })
  @ValidateIf(optional)
  @calendar()
  declare updatedFrom?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Inclusive UTC calendar day on document updatedAt.',
  })
  @ValidateIf(optional)
  @calendar()
  declare updatedTo?: string;

  /**
   * @author Cristono Wijaya
   * @description The archived filter for the document list. Must be a boolean value. Used to filter documents based on their archived status.
   * @tags Documents
   * @optional
   * @type Boolean
   * @validation IsBoolean
   * @transform Convert string to boolean if applicable
   */
  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf(optional)
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  declare archived?: boolean;

  /**
   * @author Cristono Wijaya
   * @description The date range filter for the document list. Must be valid calendar dates in the format YYYY-MM-DD. Used to filter documents based on their creation date.
   * @tags Documents
   * @optional
   * @format "date"
   * @validation ValidateBy (isCalendarDate)
   */
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  declare dateFrom?: string;

  /**
   * @author Cristono Wijaya
   * @description The end date for filtering documents based on their creation date. Must be a valid calendar date in the format YYYY-MM-DD.
   * @tags Documents
   * @optional
   * @format "date"
   * @validation ValidateBy (isCalendarDate)
   */
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  declare dateTo?: string;

  /**
   * @author Cristono Wijaya
   * @description The expiration date range filter for the document list. Must be valid calendar dates in the format YYYY-MM-DD. Used to filter documents based on their expiration date.
   * @tags Documents
   * @optional
   * @format "date"
   * @validation ValidateBy (isCalendarDate)
   */
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  declare expirationFrom?: string;

  /**
   * @author Cristono Wijaya
   * @description The end date for filtering documents based on their expiration date. Must be a valid calendar date in the format YYYY-MM-DD.
   * @tags Documents
   * @optional
   * @format "date"
   * @validation ValidateBy (isCalendarDate)
   */
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf(optional)
  @calendar()
  declare expirationTo?: string;
}
