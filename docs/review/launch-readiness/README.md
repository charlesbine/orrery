# Readout readiness verification

Verified 2026-11-24 with the synthetic solaris.lab demo.

- Phone before: station annotation extends beyond the 390px viewport.
- Phone host after: long host details fit within the viewport and scroll; dismissal remains reachable.
- Desktop after: station annotation retains the existing chart layout.

Canonical CSS/JS changes are mirrored in charlesbine.com public/demos/orrery/index.html.

Validation: npm run verify passed (16 tests); site npm run build passed. Browser checks covered desktop 1280x800 and phone 390x844, station and host selection, scrolling, and dismissal. The static site demo made no /api/status requests after 32 seconds. No production deployment was performed.
