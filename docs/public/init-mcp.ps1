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
IDUgbWNwIC0tPgojIyBQcm9qZWN0IG1lbW9yeQoKVGhpcyByZXBvc2l0b3J5IGtlZXBzIGR1cmFi
bGUgcHJvamVjdCBrbm93bGVkZ2UgaW4gYG1hY2hpbmUtbWVtb3J5YCwgcmVhY2hlZCB0aHJvdWdo
IGl0cyBNQ1AgdG9vbHMgKGBsaXN0X3JlcG9zaXRvcmllc2AgYW5kIGBtZW1vcnlfKmApLCBub3Qg
YSBDTEkuIEV2ZXJ5IHRvb2wgdGFrZXMgYHJlcG9zaXRvcnlgOiB0aGUgc2x1ZyBpbiBgLmFnZW50
cy9tYWNoaW5lLW1lbW9yeS5qc29uYCwgb3Igd2l0aG91dCB0aGF0IGZpbGUgdGhlIG9yaWdpbiBy
ZW1vdGUncyBwYXRoLCBzdWNoIGFzIGBvd25lci9uYW1lYC4gQ2hlY2sgaXQgd2l0aCBgbGlzdF9y
ZXBvc2l0b3JpZXNgIGJlZm9yZSB0aGUgZmlyc3Qgd3JpdGU6IGEgd3Jvbmcgc2x1ZyByZWFkcyBh
cyBlbXB0eSBhbmQgd3JpdGVzIHRvIGEgbmV3IHJlcG9zaXRvcnkuCgotIEJlZm9yZSBjaGFuZ2lu
ZyBjb2RlLCBzY2FuIG9uY2UgYW5kIHJlYWQgdGhlIHJlY29yZHMgdGhhdCBiZWFyIG9uIHRoZSB0
YXNrOiBgbWVtb3J5X3N1Z2dlc3RgIHdpdGggYHsgcmVwb3NpdG9yeSwgZmlsZXMgfWAgZm9yIGtu
b3duIGZpbGVzLCBvciBgbWVtb3J5X3F1ZXJ5YCB3aXRoIGB7IHJlcG9zaXRvcnksIHF1ZXJ5IH1g
IGZvciBhIHRvcGljIG9yIGEgdGFzayB0aGF0IHRvdWNoZXMgbm8gZmlsZXM7IHRoZW4gYG1lbW9y
eV9nZXRgIHdpdGggdGhlaXIgYGlkc2AuIFJlc3VsdHMgYXJlIGNhbmRpZGF0ZXM6IGp1ZGdlIHRo
ZW0gYnkgYG1hdGNoX3N0cmVuZ3RoYCwgYW5kICJub3RoaW5nIHJlbGV2YW50IiBpcyBhIHZhbGlk
IG91dGNvbWUuCi0gV2hlbiB0aGUgdXNlcidzIGluc3RydWN0aW9uIGNvbnRyYWRpY3RzIGEgc3Rv
cmVkIHJlY29yZCwgZm9sbG93IHRoZSB1c2VyIGFuZCB1cGRhdGUgdGhlIHJlY29yZC4KLSBXcml0
ZSBvbmUgZmFjdCBwZXIgcmVjb3JkIGFuZCBzdGFydCBpdCB3aXRoIHRoZSBjb21tYW5kLCBwYXRo
IG9yIGlkZW50aWZpZXIgaXQgaXMgYWJvdXQuIFN0b3JlIGRlY2lzaW9ucywgY29uc3RyYWludHMs
IHByZWZlcmVuY2VzLCByZWZlcmVuY2VzIGFuZCBnb3RjaGFzLiBQdXQgZGVsaXZlcnkgc3RhdGUg
aW4gb25lIGBzdGF0dXNgIHJlY29yZCB3aXRoIGBleHBpcmVzX2FmdGVyX2RheXNgLiBMZWF2ZSBv
dXQgcGl4ZWwgdmFsdWVzLCBVSSBzdGF0ZSBhbmQgZGVwbG95IG91dGNvbWVzLCBhbmQgcHV0IGZh
Y3RzIGFib3V0IG9uZSBtYWNoaW5lIGluIHRoYXQgbWFjaGluZSdzIGd1aWRhbmNlIGZpbGUuCi0g
Q2hlY2sgc2l6ZSBiZWZvcmUgd3JpdGluZzogYG1lbW9yeV9zaXplYCB3aXRoIHRoZSBjb250ZW50
LCB0YWdzIGFuZCBjb250ZXh0LiBDb250ZW50LCB0YWdzIGFuZCBjb250ZXh0IHNoYXJlIG9uZSAy
LDAwMC1ieXRlIGxpbWl0LgotIENoYW5nZSBhIHJlY29yZCB3aXRoIGBtZW1vcnlfdXBkYXRlYCAo
YGlkYCBhbmQgdGhlIHdob2xlIG5ldyBgY29udGVudGApLiBJdCByZXBsYWNlcyB0aGUgY29udGVu
dCwgc28gcmVhZCB0aGUgcmVjb3JkIGZpcnN0IGFuZCBrZWVwIHRoZSBkZXRhaWxzIHRoYXQgc3Rp
bGwgaG9sZC4gT21pdCBgY29udGVudGAgdG8gY2hhbmdlIG9ubHkgdGFncywgdHlwZSBvciBjZXJ0
YWludHkuIENyZWF0ZSBvbmUgd2l0aCBgbWVtb3J5X2FkZGAgYW5kIGB1cHNlcnRfbWF0Y2hgLCB3
aGljaCB1cGRhdGVzIGEgc3Ryb25nIG1hdGNoIGluc3RlYWQgb2YgYWRkaW5nIGEgZHVwbGljYXRl
LgotIFdoZW4gYSB3cml0ZSByZXBvcnRzIGBkcm9wcGVkYCBvciBgcmV2aWV3X2NhbmRpZGF0ZXNg
LCByZXN0b3JlIGRldGFpbHMgZHJvcHBlZCBieSBtaXN0YWtlIGFuZCB1cGRhdGUgb3IgZGVwcmVj
YXRlIHRoZSBsaXN0ZWQgcmVjb3Jkcy4KLSBgY2VydGFpbnR5OiB2ZXJpZmllZGAgcmVxdWlyZXMg
YGV2aWRlbmNlYDogYHVzZXJfcmVxdWlyZW1lbnRgLCBgb2JzZXJ2ZWRfaW1wbGVtZW50YXRpb25g
LCBgdmVyaWZpZWRfbWVjaGFuaXNtYCBvciBgdGVzdGVkX2JlaGF2aW9yYC4gUmVhZGluZyB0aGUg
Y29kZSBwcm92ZXMgb25seSBgb2JzZXJ2ZWRfaW1wbGVtZW50YXRpb25gLgotIFdoZW4gZGVsZWdh
dGluZywgc2NhbiBvbmNlIGFuZCBwYXNzIHRoZSByZWNvcmQgaWRzIHRvIGNoaWxkIGFnZW50cy4g
Q2hpbGRyZW4gcmV0dXJuIGZpbmRpbmdzIHdpdGggdGhlaXIgZXZpZGVuY2U7IHRoZSBwYXJlbnQg
d3JpdGVzIHRoZW0uCi0gQmVmb3JlIHRoZSBmaW5hbCByZXNwb25zZSwgbGlzdCB0aGlzIHRhc2sn
cyB3cml0ZXMgd2l0aCBgbWVtb3J5X2xpc3RgIGFuZCB0aGUgcmVjb3JkcyBmb3IgdGhlIHRvdWNo
ZWQgZmlsZXMgd2l0aCBgbWVtb3J5X3N1Z2dlc3RgLCB0aGVuIGFkZCwgdXBkYXRlIG9yIGRlcHJl
Y2F0ZSByZWNvcmRzIGZvciB3aGF0IHRoZSB0YXNrIGVzdGFibGlzaGVkLgoKUHJvamVjdCBwcmVm
ZXJlbmNlOiByZXBsYWNlIG9ic29sZXRlIHN5c3RlbXMgd2hlbiBwcmFjdGljYWw7IHByZXNlcnZl
IGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5IG9ubHkgd2hlbiBpdCBpcyBleHBsaWNpdGx5IHJlcXVp
cmVkLgo8IS0tIG1hY2hpbmUtbWVtb3J5OmVuZCAtLT4=

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
