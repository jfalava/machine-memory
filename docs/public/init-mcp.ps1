# This file is published as a static asset at:
#   https://machine-memory.jfa.dev/init-mcp.ps1
#
# MCP-only counterpart to `machine-memory init --mcp`.
# Creates or replaces the managed machine-memory block in ./AGENTS.md so agents
# that only have the remote MCP server (no CLI) follow the same workflow.
#
# Usage:
#   irm https://machine-memory.jfa.dev/init-mcp.ps1 | iex
#
# Environment:
#   MACHINE_MEMORY_AGENTS_MD  Path to write (default AGENTS.md).
#                             Absolute or relative to the current directory.

$ErrorActionPreference = "Stop"

$target = if ($env:MACHINE_MEMORY_AGENTS_MD) { $env:MACHINE_MEMORY_AGENTS_MD } else { "AGENTS.md" }
if ([System.IO.Path]::IsPathRooted($target)) {
  $agentsMd = $target
} else {
  $agentsMd = Join-Path (Get-Location) $target
}

# Managed block must stay in sync with agentsMdContent("mcp") in
# cli/src/cli/commands/agents-md-content.ts (base64 payload below).
$memoryBlockB64 = @'
PCEtLSBtYWNoaW5lLW1lbW9yeTpzdGFydCAtLT4KPCEtLSBtYWNoaW5lLW1lbW9yeTp2ZXJzaW9u
IDYgbWNwIC0tPgojIyBQcm9qZWN0IG1lbW9yeQoKVGhpcyByZXBvc2l0b3J5IGtlZXBzIGR1cmFi
bGUgcHJvamVjdCBrbm93bGVkZ2UgaW4gYG1hY2hpbmUtbWVtb3J5YCwgcmVhY2hlZCB0aHJvdWdo
IGl0cyBNQ1AgdG9vbHMsIG5vdCBhIENMSS4gRXZlcnkgdG9vbCB0YWtlcyBgcmVwb3NpdG9yeWA6
IHRoZSBzbHVnIGluIGAuYWdlbnRzL21hY2hpbmUtbWVtb3J5Lmpzb25gLCBvciB3aXRob3V0IHRo
YXQgZmlsZSB0aGUgb3JpZ2luIHJlbW90ZSdzIHBhdGgsIHN1Y2ggYXMgYG93bmVyL25hbWVgLiBD
aGVjayBpdCB3aXRoIGBsaXN0X3JlcG9zaXRvcmllc2AgYmVmb3JlIHRoZSBmaXJzdCB3cml0ZTog
YSB3cm9uZyBzbHVnIHJlYWRzIGFzIGVtcHR5IGFuZCB3cml0ZXMgdG8gYSBuZXcgcmVwb3NpdG9y
eS4KCi0gQmVmb3JlIGNoYW5naW5nIGNvZGUsIHNjYW4gb25jZSBhbmQgcmVhZCB0aGUgcmVjb3Jk
cyB0aGF0IGJlYXIgb24gdGhlIHRhc2s6IGBtZW1vcnlfc3VnZ2VzdGAgd2l0aCBgeyByZXBvc2l0
b3J5LCBmaWxlcyB9YCBmb3Iga25vd24gZmlsZXMsIG9yIGBtZW1vcnlfcXVlcnlgIHdpdGggYHsg
cmVwb3NpdG9yeSwgcXVlcnkgfWAgZm9yIGEgdG9waWMgb3IgYSB0YXNrIHRoYXQgdG91Y2hlcyBu
byBmaWxlczsgdGhlbiBgbWVtb3J5X2dldGAgd2l0aCB0aGVpciBgaWRzYC4gUmVzdWx0cyBhcmUg
Y2FuZGlkYXRlczoganVkZ2UgdGhlbSBieSBgbWF0Y2hfc3RyZW5ndGhgLCBhbmQgIm5vdGhpbmcg
cmVsZXZhbnQiIGlzIGEgdmFsaWQgb3V0Y29tZS4KLSBXaGVuIHRoZSB1c2VyJ3MgaW5zdHJ1Y3Rp
b24gY29udHJhZGljdHMgYSBzdG9yZWQgcmVjb3JkLCBmb2xsb3cgdGhlIHVzZXIgYW5kIHVwZGF0
ZSB0aGUgcmVjb3JkLgotIFdyaXRlIG9uZSBmYWN0IHBlciByZWNvcmQgYW5kIHN0YXJ0IGl0IHdp
dGggdGhlIGNvbW1hbmQsIHBhdGggb3IgaWRlbnRpZmllciBpdCBpcyBhYm91dC4gU3RvcmUgZGVj
aXNpb25zLCBjb25zdHJhaW50cywgcHJlZmVyZW5jZXMsIHJlZmVyZW5jZXMgYW5kIGdvdGNoYXMu
IFB1dCBkZWxpdmVyeSBzdGF0ZSBpbiBvbmUgYHN0YXR1c2AgcmVjb3JkIHdpdGggYGV4cGlyZXNf
YWZ0ZXJfZGF5c2AuIExlYXZlIG91dCBwaXhlbCB2YWx1ZXMsIFVJIHN0YXRlIGFuZCBkZXBsb3kg
b3V0Y29tZXMsIGFuZCBwdXQgZmFjdHMgYWJvdXQgb25lIG1hY2hpbmUgaW4gdGhhdCBtYWNoaW5l
J3MgZ3VpZGFuY2UgZmlsZS4KLSBDaGVjayBzaXplIGJlZm9yZSB3cml0aW5nOiBgbWVtb3J5X3Np
emVgIHdpdGggdGhlIGNvbnRlbnQsIHRhZ3MgYW5kIGNvbnRleHQuIENvbnRlbnQsIHRhZ3MgYW5k
IGNvbnRleHQgc2hhcmUgb25lIDIsMDAwLWJ5dGUgbGltaXQuCi0gQ2hhbmdlIGEgcmVjb3JkIHdp
dGggYG1lbW9yeV91cGRhdGVgIChgaWRgIGFuZCB0aGUgd2hvbGUgbmV3IGBjb250ZW50YCkuIEl0
IHJlcGxhY2VzIHRoZSBjb250ZW50LCBzbyByZWFkIHRoZSByZWNvcmQgZmlyc3QgYW5kIGtlZXAg
dGhlIGRldGFpbHMgdGhhdCBzdGlsbCBob2xkLiBPbWl0IGBjb250ZW50YCB0byBjaGFuZ2Ugb25s
eSB0YWdzLCB0eXBlIG9yIGNlcnRhaW50eS4gQ3JlYXRlIG9uZSB3aXRoIGBtZW1vcnlfYWRkYCBh
bmQgYHVwc2VydF9tYXRjaGAsIHdoaWNoIHVwZGF0ZXMgYSBzdHJvbmcgbWF0Y2ggaW5zdGVhZCBv
ZiBhZGRpbmcgYSBkdXBsaWNhdGUuCi0gV2hlbiBhIHdyaXRlIHJlcG9ydHMgYGRyb3BwZWRgIG9y
IGByZXZpZXdfY2FuZGlkYXRlc2AsIHJlc3RvcmUgZGV0YWlscyBkcm9wcGVkIGJ5IG1pc3Rha2Us
IGFuZCB1cGRhdGUgb3IgZGVwcmVjYXRlIHRoZSBsaXN0ZWQgcmVjb3JkcyB0aGF0IHJlbHkgb24g
d2hhdCB5b3UgY2hhbmdlZC4KLSBgY2VydGFpbnR5OiB2ZXJpZmllZGAgcmVxdWlyZXMgYGV2aWRl
bmNlYDogYHVzZXJfcmVxdWlyZW1lbnRgLCBgb2JzZXJ2ZWRfaW1wbGVtZW50YXRpb25gLCBgdmVy
aWZpZWRfbWVjaGFuaXNtYCBvciBgdGVzdGVkX2JlaGF2aW9yYC4gUmVhZGluZyB0aGUgY29kZSBw
cm92ZXMgb25seSBgb2JzZXJ2ZWRfaW1wbGVtZW50YXRpb25gLgotIFdoZW4gZGVsZWdhdGluZywg
c2NhbiBvbmNlIGFuZCBwYXNzIHRoZSByZWNvcmQgaWRzIHRvIGNoaWxkIGFnZW50cy4gQ2hpbGRy
ZW4gcmV0dXJuIGZpbmRpbmdzIHdpdGggdGhlaXIgZXZpZGVuY2U7IHRoZSBwYXJlbnQgd3JpdGVz
IHRoZW0uCi0gQmVmb3JlIHRoZSBmaW5hbCByZXNwb25zZSwgbGlzdCB0aGlzIHRhc2sncyB3cml0
ZXMgd2l0aCBgbWVtb3J5X2xpc3RgIGFuZCB0aGUgcmVjb3JkcyBmb3IgdGhlIHRvdWNoZWQgZmls
ZXMgd2l0aCBgbWVtb3J5X3N1Z2dlc3RgLCB0aGVuIGFkZCwgdXBkYXRlIG9yIGRlcHJlY2F0ZSBy
ZWNvcmRzIGZvciB3aGF0IHRoZSB0YXNrIGVzdGFibGlzaGVkLgoKUHJvamVjdCBwcmVmZXJlbmNl
OiByZXBsYWNlIG9ic29sZXRlIHN5c3RlbXMgd2hlbiBwcmFjdGljYWw7IHByZXNlcnZlIGJhY2t3
YXJkcyBjb21wYXRpYmlsaXR5IG9ubHkgd2hlbiBpdCBpcyBleHBsaWNpdGx5IHJlcXVpcmVkLgo8
IS0tIG1hY2hpbmUtbWVtb3J5OmVuZCAtLT4=

'@

$cleanB64 = $memoryBlockB64 -replace '\s', ''
try {
  $managedBlock = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($cleanB64))
} catch {
  throw "machine-memory init-mcp: could not decode managed AGENTS.md block. $_"
}
if (-not $managedBlock.EndsWith("`n")) {
  $managedBlock += "`n"
}

$startMarker = '<!-- machine-memory:start -->'
$endMarker = '<!-- machine-memory:end -->'

if (Test-Path -LiteralPath $agentsMd -PathType Leaf) {
  $existing = [System.IO.File]::ReadAllText($agentsMd)
  $action = 'Updated'
} else {
  $existing = ''
  $action = 'Created'
  $parentDir = Split-Path -Parent $agentsMd
  if ($parentDir -and -not (Test-Path -LiteralPath $parentDir)) {
    New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
  }
}

$s = $existing.IndexOf($startMarker)
$e = if ($s -ge 0) { $existing.IndexOf($endMarker, $s) } else { -1 }
if ($s -ge 0 -and $e -ge 0) {
  $after = $existing.Substring($e + $endMarker.Length)
  $out = $existing.Substring(0, $s) + $managedBlock.TrimEnd("`r", "`n") + "`n"
  if ($after) {
    $out += $after.TrimStart("`r", "`n")
    if (-not $out.EndsWith("`n")) {
      $out += "`n"
    }
  }
} else {
  $body = $existing.TrimEnd()
  $managedTrimmed = $managedBlock.TrimEnd("`r", "`n")
  if ($body) {
    $out = "$body`n`n$managedTrimmed`n"
  } else {
    $out = "$managedTrimmed`n"
  }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($agentsMd, $out, $utf8NoBom)

Write-Host "$action $agentsMd"
Write-Host "Backend  mcp (MCP tools; no CLI)"
Write-Host "Next     connect an OAuth MCP client to https://<worker-url>/mcp"
Write-Host "Docs     https://machine-memory.jfa.dev/docs/mcp/init"
