import { UploadForm } from "@/features/documents/upload-form"
import { uploadLimit } from "@/features/documents/upload-validation"
export const metadata = { title: "Upload document | QYVRA" }
export default function UploadPage() {
  return <UploadForm maxBytes={uploadLimit()} />
}
