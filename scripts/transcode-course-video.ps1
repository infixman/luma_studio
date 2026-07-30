<#
.SYNOPSIS
  Turn one video file into the HLS ladder this shop serves, and upload it.

.DESCRIPTION
  There is no transcoder in the deployment, so this is where encoding happens:
  on whichever machine has the source file and FFmpeg. The output layout is not
  a preference — the playback gateway builds object keys from it and refuses
  anything else, so the folder names and file names here have to match
  `backend/src/domain/video.py`.

  Nothing is marked playable by this script. It uploads, and then the import
  endpoint reads the master playlist and checks every object it refers to
  actually arrived. A sync that dropped one file out of several hundred is an
  ordinary occurrence, and a ladder missing one segment plays perfectly until
  it reaches that segment — which is the worst time to find out.

.PARAMETER Source
  The video file to encode.

.PARAMETER AssetId
  Optional. Reuse when re-uploading after a failed verification, so the objects
  land in the same place instead of orphaning the first attempt.

.PARAMETER EncodeVersion
  Defaults to 1. Bump it to re-encode a video members are already watching:
  outputs are versioned, so the new ladder is built alongside the live one and
  nothing switches over until it verifies.

.EXAMPLE
  ./scripts/transcode-course-video.ps1 -Source ~/lessons/lesson-01.mp4
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$AssetId,
  [int]$EncodeVersion = 1,
  [string]$Bucket = 'luma-course-video',
  [string]$WorkDir
)

$ErrorActionPreference = 'Stop'

foreach ($tool in @('ffmpeg', 'ffprobe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool not found. Install FFmpeg and put it on PATH."
  }
}
if (-not (Test-Path $Source)) { throw "No such file: $Source" }

# An id the object keys can carry. Matches ASSET_ID_PATTERN in video.py, which
# is deliberately narrow: a key is built from this, and a filename is not.
if (-not $AssetId) {
  $AssetId = 'a' + ([guid]::NewGuid().ToString('N').Substring(0, 17))
}
if ($AssetId -notmatch '^[A-Za-z0-9_-]{6,40}$') { throw "Invalid asset id: $AssetId" }

if (-not $WorkDir) { $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) "luma-encode-$AssetId" }
$outputRoot = Join-Path $WorkDir "$EncodeVersion"
New-Item -ItemType Directory -Force $outputRoot | Out-Null

# ffprobe decides the ladder, not the file extension or what anybody assumed.
$probe = & ffprobe -v quiet -print_format json -show_streams -show_format $Source | ConvertFrom-Json
$videoStream = $probe.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
if (-not $videoStream) { throw 'No video stream in that file.' }

$sourceHeight = [int]$videoStream.height
$sourceWidth = [int]$videoStream.width
$duration = [int][math]::Round([double]$probe.format.duration)

# Never above the source. Upscaling spends bandwidth and storage to deliver a
# blurrier file than the one that came in. Mirrors `ladder_for`.
$rungs = @(
  @{ Name = '1080p'; Height = 1080; Bitrate = '5000k'; Maxrate = '5350k'; Bufsize = '7500k' },
  @{ Name = '720p'; Height = 720; Bitrate = '2800k'; Maxrate = '2996k'; Bufsize = '4200k' },
  @{ Name = '480p'; Height = 480; Bitrate = '1400k'; Maxrate = '1498k'; Bufsize = '2100k' }
) | Where-Object { $_.Height -le $sourceHeight }
if ($rungs.Count -eq 0) { $rungs = @(@{ Name = '480p'; Height = 480; Bitrate = '1400k'; Maxrate = '1498k'; Bufsize = '2100k' }) }

Write-Host "Asset $AssetId  version $EncodeVersion" -ForegroundColor Cyan
Write-Host "Source ${sourceWidth}x${sourceHeight}, $duration s → $($rungs.Name -join ', ')"

foreach ($rung in $rungs) {
  $dir = Join-Path $outputRoot $rung.Name
  New-Item -ItemType Directory -Force $dir | Out-Null
  Write-Host "Encoding $($rung.Name)…"

  # Keyframes every 2s at 30fps and a 6s segment, so every segment starts on
  # one. A player can only switch rendition at a keyframe; segments that do not
  # begin with one make switching stutter or fail.
  & ffmpeg -hide_banner -loglevel error -y -i $Source `
    -vf "scale=-2:$($rung.Height)" `
    -c:v libx264 -preset medium -profile:v high -crf 21 `
    -b:v $rung.Bitrate -maxrate $rung.Maxrate -bufsize $rung.Bufsize `
    -g 60 -keyint_min 60 -sc_threshold 0 `
    -c:a aac -b:a 128k -ac 2 `
    -f hls -hls_time 6 -hls_playlist_type vod `
    -hls_segment_type fmp4 `
    -hls_fmp4_init_filename 'init.mp4' `
    -hls_segment_filename (Join-Path $dir 'segment-%06d.m4s') `
    (Join-Path $dir 'playlist.m3u8')
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed on $($rung.Name)" }
}

# A poster from a frame far enough in to be the lesson rather than a title card.
$posterAt = [math]::Max(1, [math]::Min(10, [int]($duration / 10)))
& ffmpeg -hide_banner -loglevel error -y -ss $posterAt -i $Source -frames:v 1 -vf 'scale=-2:720' `
  (Join-Path $outputRoot 'poster.webp')

# The master playlist last, and by hand rather than by ffmpeg's var_stream_map:
# relative paths are what the gateway maps to object keys, and this keeps them
# exactly one folder deep whatever ffmpeg would have written.
$master = New-Object System.Text.StringBuilder
[void]$master.AppendLine('#EXTM3U')
[void]$master.AppendLine('#EXT-X-VERSION:7')
foreach ($rung in $rungs) {
  $width = [int][math]::Round($sourceWidth * $rung.Height / $sourceHeight / 2) * 2
  $bandwidth = [int]($rung.Bitrate.TrimEnd('k')) * 1000
  [void]$master.AppendLine("#EXT-X-STREAM-INF:BANDWIDTH=$bandwidth,RESOLUTION=${width}x$($rung.Height),CODECS=`"avc1.640028,mp4a.40.2`"")
  [void]$master.AppendLine("$($rung.Name)/playlist.m3u8")
}
Set-Content -Path (Join-Path $outputRoot 'master.m3u8') -Value $master.ToString() -Encoding utf8 -NoNewline

$objects = (Get-ChildItem -Recurse -File $outputRoot).Count
Write-Host "`nEncoded $objects files into $outputRoot" -ForegroundColor Green

Write-Host @"

Next, upload and register. Content types matter: a playlist served as
octet-stream is a playlist no player will read.

  rclone copy "$outputRoot" "r2:$Bucket/videos/$AssetId/$EncodeVersion" --progress

Then register it. The endpoint reads the master playlist and checks every
object it names — it will tell you what is missing rather than accepting it:

  POST https://admin-api.luma-studio.tw/api/video-assets/import
  {
    "assetId": "$AssetId",
    "title": "$([System.IO.Path]::GetFileNameWithoutExtension($Source))",
    "originalFilename": "$([System.IO.Path]::GetFileName($Source))",
    "durationSeconds": $duration,
    "width": $sourceWidth,
    "height": $sourceHeight,
    "encodeVersion": $EncodeVersion
  }

Keep the source file. Re-encoding needs it, and the ladder cannot be rebuilt
from the ladder.
"@ -ForegroundColor Yellow
