param(
  [Parameter(Mandatory = $true)]
  [string]$ClientId
)

$device = Invoke-RestMethod `
  -Method Post `
  -Uri "https://id.twitch.tv/oauth2/device" `
  -ContentType "application/x-www-form-urlencoded" `
  -Body @{
    client_id = $ClientId
    scopes    = ""
  }

Write-Host ""
Write-Host "Open this URL in your browser:"
Write-Host $device.verification_uri
Write-Host ""
Write-Host "Enter this code:"
Write-Host $device.user_code
Write-Host ""
Read-Host "After approving in the browser, press Enter"

$token = Invoke-RestMethod `
  -Method Post `
  -Uri "https://id.twitch.tv/oauth2/token" `
  -ContentType "application/x-www-form-urlencoded" `
  -Body @{
    client_id   = $ClientId
    scopes      = ""
    device_code = $device.device_code
    grant_type  = "urn:ietf:params:oauth:grant-type:device_code"
  }

$validation = Invoke-RestMethod `
  -Method Get `
  -Uri "https://id.twitch.tv/oauth2/validate" `
  -Headers @{
    Authorization = "OAuth $($token.access_token)"
  }

Write-Host ""
Write-Host "Access Token:"
Write-Host $token.access_token
Write-Host ""
Write-Host "Refresh Token:"
Write-Host $token.refresh_token
Write-Host ""
Write-Host "Validated User:"
Write-Host "login=$($validation.login) user_id=$($validation.user_id) client_id=$($validation.client_id)"
Write-Host ""
Write-Host "Copy these into .env:"
Write-Host "TWITCH_CLIENT_ID=$ClientId"
Write-Host "TWITCH_ACCESS_TOKEN=$($token.access_token)"
Write-Host "TWITCH_REFRESH_TOKEN=$($token.refresh_token)"
