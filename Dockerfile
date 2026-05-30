# Etapa 1: Compilación (SDK)
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# Copiar la solución y restaurar dependencias
COPY ["Nivra.sln", "./"]
COPY ["Nivra.Api/Nivra.Api.csproj", "Nivra.Api/"]
RUN dotnet restore "Nivra.sln"

# Copiar el resto del código y compilar en modo Release
COPY . .
WORKDIR "/src/Nivra.Api"
RUN dotnet publish "Nivra.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Etapa 2: Producción (Runtime ligero)
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS final
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080

# Copiar los archivos compilados (incluyendo wwwroot)
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Nivra.Api.dll"]
