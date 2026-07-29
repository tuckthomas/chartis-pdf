# Chartis PDF (???t??)

> Browser-based PDF studio — a reusable microservice and React component library for rendering, annotating, signing, and processing PDF documents.

## Architecture

```
chartis-pdf/
+-- dotnet/Chartis.Pdf.Service/   ? .NET 10 microservice (Clean Architecture)
¦   +-- Chartis.Pdf.Domain        ? Core models
¦   +-- Chartis.Pdf.Application   ? Use cases & interfaces
¦   +-- Chartis.Pdf.Infrastructure? PDF engine (PDFium, PDFsharp, Tesseract)
¦   +-- Chartis.Pdf.Api           ? ASP.NET Core minimal API
+-- packages/chartis-pdf-viewer/  ? React/TS component (npm package)
```

## Quick Start

### Run API locally

```bash
docker compose up
```

### Use React Component

```bash
npm install @tuckthomas/chartis-pdf-viewer
```

```tsx
import { PdfViewer } from '@tuckthomas/chartis-pdf-viewer';

<PdfViewer
  apiUrl="http://localhost:5200"
  documentUrl="/path/to/document.pdf"
/>
```