Set oShell = CreateObject("WScript.Shell")
Set oFSO = CreateObject("Scripting.FileSystemObject")
strDir = "C:\WorkPulse"
strExe = strDir & "\WorkPulse-Agent.exe"
strLog = strDir & "\agent.log"
If oFSO.FileExists(strExe) Then
    If oFSO.FileExists(strLog) Then oFSO.DeleteFile strLog
    oShell.Run "cmd /c cd /d " & strDir & " && WorkPulse-Agent.exe >> agent.log", 0, False
End If
