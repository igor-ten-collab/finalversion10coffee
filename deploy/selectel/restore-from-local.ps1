# Run in your normal PowerShell where SSH to the new server already works.
# No passwords, private keys or .env files are copied or printed.
[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9.-]*$')]
    [string]$Server = '176.53.252.204',
    [ValidatePattern('^[a-z_][a-z0-9_-]*$')]
    [string]$SshUser = 'root',
    [ValidateRange(1, 65535)]
    [int]$Port = 22,
    [ValidatePattern('^$|^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
    [string]$Container = ''
)
$ErrorActionPreference = 'Stop'
if ($SshUser -ne 'root') { throw 'This recovery procedure requires root on the new server.' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$backupDirectory = Join-Path $workspace 'recovery-data\local-2026-11-04'
$dump = Join-Path $backupDirectory 'site.dump'
$manifest = Get-Content -LiteralPath (Join-Path $backupDirectory 'manifest.json') -Raw | ConvertFrom-Json
$actualHash = (Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $manifest.sha256) { throw 'Local backup checksum mismatch.' }
$remoteDirectory = '/root/10coffee-recovery-' + $actualHash.Substring(0, 12)
$remote = $SshUser + '@' + $Server
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$scp = (Get-Command scp.exe -ErrorAction Stop).Source
$sshOptions = @('-p', [string]$Port, '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new')
$scpOptions = @('-P', [string]$Port, '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new')

# Stage a UTF-8/LF copy so Git's Windows CRLF conversion cannot break Bash.
$stagedScript = Join-Path $backupDirectory 'restore-new-database.sh'
$scriptText = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'restore-new-database.sh')).Replace("`r`n", "`n")
[IO.File]::WriteAllText($stagedScript, $scriptText, [Text.UTF8Encoding]::new($false))

Write-Host "Checking SSH and creating a private recovery directory on $Server..."
& $ssh @sshOptions $remote ('test "$(id -u)" = 0 && command -v docker >/dev/null && install -d -m 700 ' + $remoteDirectory)
if ($LASTEXITCODE -ne 0) { throw 'SSH or Docker check failed. Nothing was restored.' }
$remoteHashOutput = & $ssh @sshOptions $remote ('if test -e ' + $remoteDirectory + '/site.dump; then sha256sum ' + $remoteDirectory + '/site.dump; else echo MISSING; fi')
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the remote backup path.' }
$remoteHashLine = ($remoteHashOutput -join "`n").Trim()
if ($remoteHashLine -eq 'MISSING') {
    Write-Host 'Uploading the verified database archive...'
    & $scp @scpOptions $dump ($remote + ':' + $remoteDirectory + '/site.dump')
    if ($LASTEXITCODE -ne 0) { throw 'Backup upload failed. Nothing was restored.' }
} elseif (-not $remoteHashLine.StartsWith($actualHash + ' ')) {
    throw 'A different remote backup already exists. Refusing to overwrite it.'
}
& $scp @scpOptions $stagedScript ($remote + ':' + $remoteDirectory + '/restore-new-database.sh')
if ($LASTEXITCODE -ne 0) { throw 'Recovery script upload failed. Nothing was restored.' }

Write-Host 'Restoring only if the target application database is empty...'
$restoreCommand = 'bash ' + $remoteDirectory + '/restore-new-database.sh'
if ($Container) { $restoreCommand += ' ' + $Container }
& $ssh @sshOptions $remote $restoreCommand
if ($LASTEXITCODE -ne 0) { throw 'Recovery did not finish successfully. Keep the output for diagnosis.' }
Write-Host 'Database restored and counts verified. Keep payments and external sync disabled until application checks pass.'
