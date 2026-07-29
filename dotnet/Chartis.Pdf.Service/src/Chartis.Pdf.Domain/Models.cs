namespace Chartis.Pdf.Domain;

public record PdfDocumentMetadata(
    string Title,
    string? Author,
    int PageCount,
    long FileSizeBytes
);

public record PdfPageRenderRequest(
    byte[] PdfBytes,
    int PageIndex,
    int Dpi = 150
);

public record PdfAnnotation(
    int PageIndex,
    string Type,
    double X,
    double Y,
    double Width,
    double Height,
    string? Content
);