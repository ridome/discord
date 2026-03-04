param(
  [Parameter(Mandatory = $true)]
  [string]$RepoPath
)

$resolvedRepo = (Resolve-Path -LiteralPath $RepoPath).Path.ToLowerInvariant()
$processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue

foreach ($proc in $processes) {
  $cmd = $proc.CommandLine
  if (-not $cmd) {
    continue
  }

  $normalizedCmd = $cmd.ToLowerInvariant()
  if ($normalizedCmd.Contains($resolvedRepo) -and $normalizedCmd.Contains("src/index.ts")) {
    Write-Output $proc.ProcessId
    break
  }
}
