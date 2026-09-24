# Prelim Cropper

A browser-based PDF segmentation tool for exam papers.

## V1 scope
- Opens a local PDF entirely in the browser.
- Shows pages as a continuous vertical document.
- Hides a configurable header/footer region.
- Lets a teacher add, drag and delete horizontal cut lines.
- Can suggest conservative cut lines from likely standalone question numbers.
- Exports a `.segmentation.json` file containing the original page-relative cut coordinates.

## Local development
```bash
npm install
npm run dev
```

## Deploy to Vercel
Import the repository into Vercel and use the default Vite settings:
- Build command: `npm run build`
- Output directory: `dist`

No server or database is required for this version.
