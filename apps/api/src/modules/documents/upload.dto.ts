/** @description Safe creation receipt persisted for idempotency; never contains infrastructure or ownership keys. */
export interface UploadResponse {
  id: string;
  title: string;
  status: string;
  documentType: string;
  issuer: string | null;
  referenceNumber: string | null;
  documentDate: string | null;
  expirationDate: string | null;
  createdAt: string;
  category:
    (UploadRelation & { color: string | null; icon: string | null }) | null;
  tags: UploadRelation[];
  version: {
    id: string;
    versionNumber: number;
    originalFilename: string;
    mimeType: string;
    fileSize: number;
    pageCount: number | null;
    extractionStatus: string;
    createdAt: string;
  };
}
interface UploadRelation {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
