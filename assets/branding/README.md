# Nienie Logo

Selected mark: **P6**. The cat is buttery yellow with cornflower blue facial and chest details on a soft peach field.

`nienie-logo-p6.png` is the canonical 1254 × 1254 source. Keep it as the master and regenerate platform outputs with `pnpm brand:assets` after changing the source.

## Platform handling

- iOS, Android, and macOS launcher artwork stays square in its source files. The operating system applies its own icon mask; do not bake rounded corners into these files.
- Android uses adaptive icon XML with the peach background color and the P6 artwork as its foreground layer.
- The website uses PNG favicons, an ICO fallback, an Apple touch icon, and a PWA manifest.
- In-app marks use the same square art clipped by the component radius (8 px on the website, 19 px in the desktop About panel, and 6 px in the mobile app bar).
- Mobile launch screens use the logo on a matching peach field.

The asset generator uses macOS `sips` to create the required raster sizes and writes the desktop ICO/ICNS containers from those PNG variants.
