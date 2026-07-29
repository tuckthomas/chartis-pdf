export interface PdfViewerProps {
  apiUrl?: string;
  documentUrl?: string;
  onSave?: (pdfBytes: ArrayBuffer) => void;
  readOnly?: boolean;
}