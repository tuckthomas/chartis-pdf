# Chartis PDF Studio

[![Framework](https://img.shields.io/badge/.NET-10.0-blue)](#)
[![npm](https://img.shields.io/badge/npm-%40tuckthomas%2Fchartis--pdf--viewer-red)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](#)

> Browser-based PDF studio microservice and React component library for rendering, annotating, signing, and processing PDF documents.

---

## Overview

Chartis is composed of two primary deliverables:

1. **`@tuckthomas/chartis-pdf-viewer`**: React component library providing an Acrobat-style PDF viewer and editor UI in the browser.
2. **`Chartis.Pdf.Api`**: .NET 10 microservice backend handling PDFium page rendering, Tesseract OCR, annotation processing, and document operations.

---

## Component Installation (React)

Install the UI component library into any React project:

```bash
npm install @tuckthomas/chartis-pdf-viewer
```

### Usage

```tsx
import { PDFViewer } from '@tuckthomas/chartis-pdf-viewer';

export function DocumentEditorPage() {
  return (
    <div style={{ height: '100vh' }}>
      <PDFViewer
        apiUrl="http://localhost:5200"
        documentUrl="https://example.com/sample.pdf"
        onSave={(pdfBytes) => console.log('Saved PDF', pdfBytes.byteLength)}
      />
    </div>
  );
}
```

---

## Backend Microservice Setup (.NET 10)

### Running via Docker Compose

```bash
docker compose up -d
```

The API service runs on `http://localhost:5200`.

### Building from Source

```bash
dotnet build dotnet/Chartis.Pdf.Service/Chartis.Pdf.Service.sln
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Service health check |
| `POST` | `/api/pdf/render` | Render PDF page(s) to image output |
| `POST` | `/api/pdf/extract-text` | Extract text layer / Tesseract OCR |
| `POST` | `/api/pdf/annotate` | Add annotations to PDF document |
| `POST` | `/api/pdf/merge` | Merge multiple PDF files |
| `POST` | `/api/pdf/split` | Split PDF into page ranges |

---

## License

Distributed under the [MIT License](LICENSE).