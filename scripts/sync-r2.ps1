[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')]
    [string]$Id,
    [string]$Bucket = 'luma-ibon-images'
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot "..\upload_ibon\$Id"
$resolvedSource = Resolve-Path -LiteralPath $source -ErrorAction Stop
$images = Get-ChildItem -LiteralPath $resolvedSource -File |
    Where-Object { $_.Extension -match '^\.(jpg|jpeg|png|bmp|gif)$' }

if ($images.Count -eq 0) {
    throw "No supported images found in $resolvedSource"
}

foreach ($image in $images) {
    $r2Key = "$Id/$($image.Name)"
    Write-Host "Uploading $r2Key"
    uv run pywrangler r2 object put "$Bucket/$r2Key" --file $image.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "R2 upload failed: $r2Key"
    }
}
