import base64, io, os, zipfile, sys
APP='app'; out=sys.argv[1]
buf=io.BytesIO()
with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:
    for root,dirs,files in os.walk(APP):
        dirs[:]=[d for d in dirs if d!='__pycache__']
        for f in files:
            p=os.path.join(root,f); z.write(p,os.path.relpath(p,APP).replace(os.sep,'/'))
b64=base64.b64encode(buf.getvalue()).decode()
lines='\r\n'.join(b64[i:i+76] for i in range(0,len(b64),76))
ps=open('installer_template.ps1',encoding='utf-8').read().replace('θα τo κατεβάσω','θα το κατεβάσω').replace('__PAYLOAD__',lines)
ps=ps.replace('\r\n','\n').replace('\n','\r\n')
head=('@echo off\r\nchcp 65001 >nul\r\ntitle DjFah Radio - Installer\r\nset "DJFAH_SELF=%~f0"\r\n'
 "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$t=[IO.File]::ReadAllText($env:DJFAH_SELF,[Text.Encoding]::UTF8); "
 "$i=$t.IndexOf('#'+'#PS_BEGIN#'+'#'); $p=Join-Path $env:TEMP 'djfah_radio_setup.ps1'; "
 "[IO.File]::WriteAllText($p,$t.Substring($i),(New-Object Text.UTF8Encoding $true)); & powershell -NoProfile -ExecutionPolicy Bypass -File $p\"\r\n"
 'echo.\r\npause\r\nexit /b\r\n##PS_BEGIN##\r\n')
open(out,'w',encoding='utf-8',newline='').write(head+ps)
print(out, round(os.path.getsize(out)/1e6,2),'MB', 'zip', round(len(buf.getvalue())/1e6,2),'MB')
