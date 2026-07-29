using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using PdfSharp.Pdf;
using PdfSharp.Pdf.IO;
using SkiaSharp;
using Tesseract;
using SkiaMime.Application.Common;
using SkiaMime.Application.Interfaces;

namespace SkiaMime.Infrastructure.Services
{
    public class OcrService : IOcrService
    {
        private readonly string _tessDataPath;

        public OcrService(string tessDataPath = "./tessdata")
        {
            _tessDataPath = tessDataPath;
        }

        public string GetTesseractVersion()
        {
            try
            {
                using (var engine = new TesseractEngine(_tessDataPath, "eng", EngineMode.Default))
                {
                    return $"Tesseract {engine.Version}";
                }
            }
            catch
            {
                return "missing";
            }
        }

        public async Task<byte[]> JpegBytesToPdfWithOcr(IEnumerable<byte[]> jpegPages, int dpi, string language = "eng", int timeoutSeconds = 120)
        {
            var tempDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
            Directory.CreateDirectory(tempDir);
            var perPagePdfs = new List<string>();

            try
            {
                int pageIndex = 0;
                foreach (var pageBytes in jpegPages)
                {
                    var imagePath = Path.Combine(tempDir, $"page_{pageIndex:D4}.jpg");
                    await File.WriteAllBytesAsync(imagePath, pageBytes);

                    var outBase = Path.Combine(tempDir, $"page_{pageIndex:D4}_ocr");
                    var outPdf = $"{outBase}.pdf";

                    var startInfo = new ProcessStartInfo
                    {
                        FileName = "tesseract",
                        Arguments = $"{imagePath} {outBase} -l {language} -c user_defined_dpi={dpi} pdf",
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };

                    using (var process = new Process { StartInfo = startInfo })
                    {
                        process.Start();
                        if (!process.WaitForExit(TimeSpan.FromSeconds(timeoutSeconds)))
                        {
                            process.Kill();
                            throw new TimeoutException($"OCR timed out after {timeoutSeconds}s on page {pageIndex}.");
                        }
                    }

                    perPagePdfs.Add(outPdf);
                    pageIndex++;
                }

                using (var outputDoc = new PdfSharp.Pdf.PdfDocument())
                {
                    foreach (var pdfPath in perPagePdfs)
                    {
                        using (var inputDoc = PdfReader.Open(pdfPath, PdfDocumentOpenMode.Import))
                        {
                            foreach (var page in inputDoc.Pages)
                            {
                                outputDoc.AddPage(page);
                            }
                        }
                    }

                    using (var ms = new MemoryStream())
                    {
                        outputDoc.Save(ms);
                        return ms.ToArray();
                    }
                }
            }
            finally
            {
                if (Directory.Exists(tempDir)) Directory.Delete(tempDir, true);
            }
        }

        public async Task<byte[]> ImagesToPdfWithOcr(IEnumerable<SKBitmap> images, int dpi, int jpegQuality, string language = "eng", int timeoutSeconds = 120)
        {
            var jpegPages = images.Select(image =>
            {
                using (var ms = new MemoryStream())
                {
                    image.Encode(ms, SKEncodedImageFormat.Jpeg, jpegQuality);
                    return ms.ToArray();
                }
            });

            return await JpegBytesToPdfWithOcr(jpegPages, dpi, language, timeoutSeconds);
        }

        public (List<SKRectI> Boxes, Dictionary<string, object> Metadata) FindIdentifierBoxes(SKBitmap image, string language = "eng", int timeoutSeconds = 30, int maxMatches = 4)
        {
            var boxes = new List<SKRectI>();
            
            using (var engine = new TesseractEngine(_tessDataPath, language, EngineMode.Default))
            {
                using (var img = Pix.LoadFromMemory(image.Encode(SKEncodedImageFormat.Jpeg, 85).ToArray()))
                {
                    using (var page = engine.Process(img, PageSegMode.SparseText))
                    {
                        using (var iter = page.GetIterator())
                        {
                            iter.Begin();
                            do
                            {
                                var text = iter.GetText(PageIteratorLevel.Word);
                                if (!string.IsNullOrEmpty(text) && PiiAnonymizer.TokenMatchesSsn(text))
                                {
                                    if (iter.TryGetBoundingBox(PageIteratorLevel.Word, out var rect))
                                    {
                                        boxes.Add(new SKRectI(rect.X1, rect.Y1, rect.X2, rect.Y2));
                                    }
                                }
                            } while (iter.Next(PageIteratorLevel.Word) && boxes.Count < maxMatches);
                        }
                    }
                }
            }

            return (boxes, new Dictionary<string, object>
            {
                { "matches", boxes.Count },
                { "language", language },
                { "timeout_seconds", timeoutSeconds }
            });
        }
    }
}