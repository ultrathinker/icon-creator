# SVG skeleton

Read with step D2 of `SKILL.md`. A safe skeleton to start from: replace the placeholder rect with a motif 150-160 units
wide, centred in the container, in high contrast to it.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3730A3"/>
      <stop offset="1" stop-color="#0EA5E9"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="236" height="236" rx="52" fill="url(#bg)"/>
</svg>
```
