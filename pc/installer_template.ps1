$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$AppName = 'DjFah Radio'
$Root    = Join-Path $env:LOCALAPPDATA 'DjFahRadio'
$InstDir = Join-Path $Root 'app'
$PyUrl   = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe'

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
$owner.Show()

function Ask([string]$text) {
    $r = [System.Windows.Forms.MessageBox]::Show($owner, $text, $AppName, 'YesNo', 'Question')
    return ($r -eq 'Yes')
}
function Tell([string]$text, [string]$icon) {
    if (-not $icon) { $icon = 'Information' }
    [void][System.Windows.Forms.MessageBox]::Show($owner, $text, $AppName, 'OK', $icon)
}
function Step([string]$n, [string]$text) {
    Write-Host ''
    Write-Host ('[' + $n + '] ' + $text) -ForegroundColor Cyan
}
function Run([string]$exe, [string]$argLine, [string]$log) {
    $p = Start-Process -FilePath $exe -ArgumentList $argLine -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
    return $p.ExitCode
}
function Find-Python {
    $cands = @()
    foreach ($v in @('313', '312', '311', '310')) {
        $cands += (Join-Path $env:LOCALAPPDATA ('Programs\Python\Python' + $v + '\python.exe'))
        if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles ('Python' + $v + '\python.exe')) }
    }
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd -and ($cmd.Source -notlike '*WindowsApps*')) { $cands += $cmd.Source }
    foreach ($c in $cands) {
        if (Test-Path $c) {
            try {
                $v = & $c -c "import sys, ssl; print('%d.%d' % sys.version_info[:2])" 2>$null
                if ("$v" -match '^3\.(10|11|12|13)$') { return $c }
            } catch { }
        }
    }
    return $null
}

$AppB64 = @'
__PAYLOAD__
'@

try {
    Write-Host '=== DjFah Radio - Εγκατάσταση ===' -ForegroundColor Magenta

    $q = "Θα εγκαταστήσω το DjFah Radio στον υπολογιστή σου.`n`n" +
         "Χρειάζεται internet. Αν δεν έχεις Python, θα τo κατεβάσω (περίπου 25 MB), αλλιώς τελειώνει σε λιγότερο από ένα λεπτό.`n`n" +
         "Τα αγαπημένα και τα τραγούδια σου, αν υπάρχουν από παλιότερη έκδοση, μένουν όπως είναι.`n`nΝα συνεχίσω;"
    if (-not (Ask $q)) {
        Write-Host 'Η εγκατάσταση ακυρώθηκε.'
        return
    }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null

    # ---- 1. Python ----
    Step '1/4' 'Έλεγχος του Python...'
    $py = Find-Python
    if (-not $py) {
        Step '1/4' 'Κατεβάζω και εγκαθιστώ το Python (λίγο υπομονή)...'
        $setup = Join-Path $env:TEMP 'python-3.12.10-amd64.exe'
        try {
            Invoke-WebRequest -Uri $PyUrl -OutFile $setup -UseBasicParsing
        } catch {
            throw 'Δεν μπόρεσα να κατεβάσω το Python. Έλεγξε ότι έχεις internet και ξανατρέξε την εγκατάσταση.'
        }
        [void](Run $setup '/quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 Shortcuts=0' (Join-Path $Root 'python-setup.log'))
        $py = Find-Python
        if (-not $py) { throw 'Η εγκατάσταση του Python δεν ολοκληρώθηκε.' }
    }
    $pyw = Join-Path (Split-Path $py) 'pythonw.exe'
    if (-not (Test-Path $pyw)) { $pyw = $py }

    # ---- 2. Κλείσιμο παλιάς έκδοσης ----
    Step '2/4' 'Προετοιμασία...'
    try { Invoke-WebRequest -Uri 'http://127.0.0.1:48231/api/quit' -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 2 } catch { }

    # ---- 3. Αρχεία εφαρμογής ----
    Step '3/4' 'Εγκατάσταση της εφαρμογής (εικόνες, γραμματοσειρές, 263 σταθμοί)...'
    $zip = Join-Path $env:TEMP 'djfah_radio_app.zip'
    [IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String($AppB64))
    if (Test-Path $InstDir) { Remove-Item -Recurse -Force $InstDir }
    Expand-Archive -Path $zip -DestinationPath $InstDir -Force
    Remove-Item -Force $zip
    $appPath = Join-Path $InstDir 'server.py'
    $ico = Join-Path $InstDir 'djfah_radio.ico'
    if (-not (Test-Path $appPath)) { throw 'Τα αρχεία της εφαρμογής δεν αποσυμπιέστηκαν σωστά.' }

    $ws = New-Object -ComObject WScript.Shell
    $links = @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DjFah Radio.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'DjFah Radio.lnk')
    )
    foreach ($l in $links) {
        $s = $ws.CreateShortcut($l)
        $s.TargetPath = $pyw
        $s.Arguments = '"' + $appPath + '"'
        $s.WorkingDirectory = $InstDir
        if (Test-Path $ico) { $s.IconLocation = $ico }
        $s.Description = 'DjFah Radio'
        $s.Save()
    }

    # ---- 4. Έλεγχος ----
    Step '4/4' 'Έλεγχος ότι όλα δουλεύουν...'
    $stLog = Join-Path $Root 'selftest.log'
    if (Test-Path $stLog) { Remove-Item -Force $stLog }
    $code = Run $py ('"' + $appPath + '" --selftest "' + $stLog + '"') (Join-Path $Root 'selftest.out')
    $report = ''
    if (Test-Path $stLog) { $report = Get-Content -Path $stLog -Raw -Encoding UTF8 }

    Write-Host ''
    if ($code -eq 0) {
        Write-Host 'Ολοκληρώθηκε!' -ForegroundColor Green
        $extra = ''
        if ($report -match 'FAIL') { $extra = "`nΗ σύνδεση με τη βάση σταθμών δεν πέτυχε τώρα (μάλλον θέμα internet). Η εφαρμογή είναι εγκατεστημένη, δοκίμασέ την.`n" }
        Tell ("Η εγκατάσταση τελείωσε!`n`nΘα βρεις το εικονίδιο DjFah Radio στην επιφάνεια εργασίας σου.`nΤην πρώτη φορά η εφαρμογή ελέγχει την ποιότητα όλων των σταθμών (περίπου 2 λεπτά), ενώ μπορείς ήδη να ακούς.`n`n" + $report + $extra)
        if (Ask 'Να ανοίξω την εφαρμογή τώρα;') {
            Start-Process -FilePath $pyw -ArgumentList ('"' + $appPath + '"') -WorkingDirectory $InstDir
        }
    } else {
        Write-Host 'Η εγκατάσταση τελείωσε, αλλά ο έλεγχος βρήκε πρόβλημα.' -ForegroundColor Yellow
        Tell ("Η εγκατάσταση τελείωσε, αλλά ο έλεγχος βρήκε κάτι που θέλει προσοχή:`n`n" + $report + "`nΞανατρέξε την εγκατάσταση. Αν συνεχίσει, στείλε μου αυτό το μήνυμα.") 'Warning'
    }
}
catch {
    Write-Host ''
    Write-Host ('ΣΦΑΛΜΑ: ' + $_.Exception.Message) -ForegroundColor Red
    Tell ("Κάτι δεν πήγε καλά:`n`n" + $_.Exception.Message + "`n`nΤα αρχεία καταγραφής βρίσκονται στον φάκελο:`n" + $Root) 'Error'
}
finally {
    $owner.Close()
}
