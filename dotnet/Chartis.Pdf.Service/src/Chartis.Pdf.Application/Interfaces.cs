using Chartis.Pdf.Domain;

namespace Chartis.Pdf.Application;

public interface IPdfService
{
    Task<byte[]> RenderPageToImageAsync(byte[] pdfBytes, int pageIndex, int dpi = 150);
    Task<List<byte[]>> RenderAllPagesToImagesAsync(byte[] pdfBytes, int dpi = 150);
    Task<PdfDocumentMetadata> GetMetadataAsync(byte[] pdfBytes);
}

public interface IOcrService
{
    Task<string> ExtractTextFromImageAsync(byte[] imageBytes);
    Task<string> ExtractTextFromPdfPageAsync(byte[] pdfBytes, int pageIndex);
}