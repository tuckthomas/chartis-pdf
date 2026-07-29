FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY ["Chartis.Pdf.Api/Chartis.Pdf.Api.csproj", "Chartis.Pdf.Api/"]
COPY ["Chartis.Pdf.Infrastructure/Chartis.Pdf.Infrastructure.csproj", "Chartis.Pdf.Infrastructure/"]
COPY ["Chartis.Pdf.Application/Chartis.Pdf.Application.csproj", "Chartis.Pdf.Application/"]
COPY ["Chartis.Pdf.Domain/Chartis.Pdf.Domain.csproj", "Chartis.Pdf.Domain/"]
RUN dotnet restore "Chartis.Pdf.Api/Chartis.Pdf.Api.csproj"
COPY . .
WORKDIR "/src/Chartis.Pdf.Api"
RUN dotnet build "Chartis.Pdf.Api.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "Chartis.Pdf.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "Chartis.Pdf.Api.dll"]