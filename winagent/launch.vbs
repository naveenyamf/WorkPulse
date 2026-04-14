Set oShell = CreateObject("WScript.Shell")
oShell.Run "cmd /c """ & "C:\WorkPulse\WorkPulse-Agent.exe" & """ >> C:\WorkPulse\agent.log 2>nul", 0, False
