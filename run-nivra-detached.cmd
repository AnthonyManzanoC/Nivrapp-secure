@echo off
cd /d "C:\Users\USER\Documents\New project 4"
set ASPNETCORE_ENVIRONMENT=Development
"C:\Program Files\dotnet\dotnet.exe" run --no-build --no-launch-profile --project "Nivra.Api\Nivra.Api.csproj" --urls "http://localhost:5055" > "Nivra.Api\server.log" 2>&1
