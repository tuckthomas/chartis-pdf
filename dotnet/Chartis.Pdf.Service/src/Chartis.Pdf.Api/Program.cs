var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();
    });
});

var app = builder.Build();
app.UseCors();

app.MapGet("/health", () => Results.Ok(new { status = "healthy", service = "chartis-pdf" }));

app.MapPost("/api/pdf/render", async (HttpContext ctx) =>
{
    // Stub for page rendering endpoint
    return Results.Ok(new { status = "rendered" });
});

app.MapPost("/api/pdf/extract-text", async (HttpContext ctx) =>
{
    // Stub for OCR / text extraction endpoint
    return Results.Ok(new { status = "extracted" });
});

app.Run();