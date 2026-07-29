using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using PdfSharp.Drawing;
using PdfSharp.Pdf;
using PdfSharp.Pdf.IO;
using PDFiumSharp;
using SkiaSharp;
using SkiaMime.Application.Interfaces;

namespace SkiaMime.Infrastructure.Services
{
    public class PdfService : IPdfService
    {
        public int CountPages(byte[] pdfBytes)
        {
            using (var doc = new PDFiumSharp.PdfDocument(pdfBytes))
            {
                return doc.Pages.Count;
            }
        }

        public byte[] ImagesToPdf(IEnumerable<SKBitmap> images, int jpegQuality)
        {
            using (var outputDoc = new PdfSharp.Pdf.PdfDocument())
            {
                foreach (var bitmap in images)
                {
                    var page = outputDoc.AddPage();
                    using (var gfx = XGraphics.FromPdfPage(page))
                    {
                        using (var ms = new MemoryStream())
                        {
                            bitmap.Encode(ms, SKEncodedImageFormat.Jpeg, jpegQuality);
                            ms.Position = 0;
                            using (var xImage = XImage.FromStream(ms))
                            {
                                page.Width = XUnit.FromPoint(xImage.PointWidth);
                                page.Height = XUnit.FromPoint(xImage.PointHeight);
                                gfx.DrawImage(xImage, 0, 0, page.Width.Point, page.Height.Point);
                            }
                        }
                    }
                }

                using (var resultStream = new MemoryStream())
                {
                    outputDoc.Save(resultStream);
                    return resultStream.ToArray();
                }
            }
        }

        public byte[] MergeVectorOverlay(byte[] sourcePdfBytes, byte[] overlayPdfBytes)
        {
            using (var sourceStream = new MemoryStream(sourcePdfBytes))
            using (var overlayStream = new MemoryStream(overlayPdfBytes))
            using (var outStream = new MemoryStream())
            {
                var sourceDoc = PdfReader.Open(sourceStream, PdfDocumentOpenMode.Modify);
                var overlayDoc = PdfReader.Open(overlayStream, PdfDocumentOpenMode.Import);

                if (overlayDoc.PageCount == 0) return sourcePdfBytes;

                // For PdfSharp 6.1, XPdfForm uses fromStream or fromFile
                var form = XPdfForm.FromStream(overlayStream);

                foreach (var page in sourceDoc.Pages)
                {
                    using (var gfx = XGraphics.FromPdfPage(page, XGraphicsPdfPageOptions.Append))
                    {
                        gfx.DrawImage(form, 0, 0, page.Width.Point, page.Height.Point);
                    }
                }

                sourceDoc.Save(outStream);
                return outStream.ToArray();
            }
        }

        public List<SKBitmap> RenderPdfToImages(byte[] pdfBytes, int dpi)
        {
            var bitmaps = new List<SKBitmap>();
            using (var doc = new PDFiumSharp.PdfDocument(pdfBytes))
            {
                foreach (var page in doc.Pages)
                {
                    int width = (int)(page.Width * dpi / 72);
                    int height = (int)(page.Height * dpi / 72);
                    
                    using (var pdfBitmap = new PDFiumBitmap(width, height, true))
                    {
                        // Clear with white (0xFFFFFFFF)
                        pdfBitmap.Fill(0xFFFFFFFF);
                        
                        page.Render(pdfBitmap);
                        
                        using (var ms = new MemoryStream())
                        {
                            pdfBitmap.Save(ms);
                            ms.Position = 0;
                            var bitmap = SKBitmap.Decode(ms);
                            if (bitmap != null)
                            {
                                bitmaps.Add(bitmap);
                            }
                        }
                    }
                }
            }
            return bitmaps;
        }
    }
}
