$env:ASPNETCORE_ENVIRONMENT = "Development"
Set-Location "C:\Users\USER\Documents\New project 4"
& "C:\Program Files\dotnet\dotnet.exe" run --no-build --no-launch-profile --project "Nivra.Api\Nivra.Api.csproj" --urls "http://localhost:5055" *> "Nivra.Api\server.log"
