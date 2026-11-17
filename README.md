# Collage Studio (draft)

Build a printable sticker collage from your own images (or openly licensed images found online), lay them out randomly, then fine‑tune every sticker by hand.

## Run

```
node server.js
```

Open http://localhost:5173. You need Node 18+. There's nothing to install.

### On your phone or tablet
Put the phone on the same Wi-Fi as the computer and open `http://<your-computer's-IP>:5173`. Run `ipconfig` to find the IPv4 address. Windows may ask once to allow Node through the firewall.

### Optional: Google Images
Openverse (openly licensed images, no key needed) is the default search source. To enable Google as well, set these before starting:

```
set GOOGLE_API_KEY=...   (PowerShell: $env:GOOGLE_API_KEY="...")
set GOOGLE_CX=...        (a Programmable Search Engine ID with image search on)
```

Note: Google has closed the Custom Search JSON API to new customers, so this only works if you already have access.

## Features
- **Stickers:** upload, drag and drop or paste images (Ctrl/⌘+V, or the *Paste* button), including a copied link to an image. You can also search online. Tick a sticker to use it and set how many copies the random layout should place. Click a sticker's name to rename it. *Place* adds a single copy. *Duplicate* makes a separate sticker from the same image, for example to crop a different part of it; *Reset to original* in the editor returns to the full source image. The *Copies for ticked* bar sets a number of copies, or adds or removes one, for every ticked sticker at once.
- **Sticker editor:** crop with free or fixed ratios. Remove the background automatically (subject segmentation runs in the browser and generates nothing) or by clicking a colour (magic wand with a tolerance setting). Erase by hand with the **Rubber** brush (adjustable size, with stroke-by-stroke undo), or use **Draw to crop** to cut out the part to keep. In Draw to crop, click or tap to place corners that are joined by straight lines, or press and drag to draw freehand; the two can be mixed. Close the shape by clicking the first corner, double-clicking or pressing Enter. Backspace removes the last point and Escape clears the shape. The editor view can always be zoomed (up to 3200%) with Ctrl/⌘ + scroll, a pinch or the −/+ buttons. Pan by scrolling, dragging (when no tool is active), Space + drag or two fingers. Colour picking stays on until you click *Done picking colours*, so you can clean up several small areas while zoomed in. The brush size stays the same on screen, so zooming in gives a finer brush for detailed edges. Switching tools applies unsaved strokes; *Cancel* or *Undo step* discards them. Add an outline in any colour that follows the cut‑out edge.
  - **Restore brush:** in the Rubber tool, switch to *Restore*, or hold Alt, to paint the original image back. This works even outside the current edges, for example to fix what background removal took away.
  - **Shape:** cut the sticker into a circle, oval, rounded rectangle, heart or star.
  - **Edges:** *Smooth* rounds off jagged edges, *Shrink edge* drops a halo of old background, *Feather* softens the edge, and *Remove specks* deletes leftover bits.
  - **Colour:** brightness, contrast, saturation, black & white, and a colour tint.
  - **Shadow:** a drop shadow with distance, softness, strength and direction. Every copy's shadow falls the same way even when rotated, and it's included in the export.
  - Shape, edges, colour, shadow and outline never change the original image, so they can be adjusted or switched off at any time. Edits can be undone, reset, and they update copies already on the print.
- **Random layout:** choose a style:
  - **Scatter** spreads stickers evenly.
  - **Pile** heaps them in the middle.
  - **Packed** fills the page with no overlaps. Stickers that don't fit are shrunk, then reported.
  - **Grid** puts them in tidy rows.
  - **Circle** arranges rings around the centre, optionally pointing outward.
  - **Shape** fills a heart, star, circle or word.

  Controls: size, size variation, rotation, overlap (for Scatter, Circle and Shape), a margin around the edge, and an option to let stickers run off the edges. Packed, Grid and Shape size the stickers automatically.

  Each sticker has a **Size** weight (½× to 3×) next to Copies, which can also be set for every ticked sticker at once.

  **Locked items stay put** when you regenerate. Scatter, Pile, Packed and Shape place new stickers around them.

  Layout settings are saved with the project.
- **Grid & rulers:** rulers in cm, in or px follow the zoom and highlight the selection. A grid with a choice of spacing is drawn under the stickers and never printed, and with snapping on, items also snap to it. These preferences are remembered in the browser.
- **Zoom & pan:** the zoom slider, −/+ buttons, *Fit*, and clicking the % to jump to 100% (actual print pixels). With a mouse or trackpad, scroll to pan and Ctrl/⌘ + scroll or a trackpad pinch to zoom at the pointer. Hold Space and drag, or middle-drag, to pan. The shortcuts are Ctrl + = / − / 0. On touch screens, pinch on empty space to zoom and drag empty space with one finger to pan. Anything hanging off the page is dimmed, because it won't print.
- **Dark mode:** the ◐/☾/☀ button in the header switches between following the system, always dark and always light. The print itself keeps its own colours.
- **Finding stickers:** search by name or `#tag` (accents are ignored), and sort by order added, name, copies, how many are on the print, or ticked first.
  - Add tags with *+ tag*; separate several with commas. Click a tag to filter by it.
  - Images added from search are tagged with the search words.
  - *All*, *None* and the copies bar act on the stickers currently shown.
- **Layers:** a list of everything on the print, front first, with copies numbered ("Rose · 3").
  - Click a row to select it; Ctrl/⌘-click or the tick box adds to the selection, and Shift-click selects a range.
  - Drag ⋮⋮ to reorder, or use *Front / Forward / Back / Bottom* on the selection.
  - The eye hides an item, and hidden items aren't printed. The lock stops an item being selected or moved on the print.
  - Double-click a sticker's name to rename it.
  - Badges flag stickers enlarged too far for print: amber below 220 DPI, red below 150 DPI. The red ones are also counted in the Layers heading.
  - *Select all* (Ctrl+A) and *Clear print* (can be undone) are at the top.
  - The *Print*, *Random layout* and *Layers* headings collapse when clicked.
- **Selecting several items:** drag a box on empty space, or Shift/Ctrl/⌘-click on the print. You can also use the Layers list, or *Select all copies* for a sticker. Then move, rotate, align, duplicate or delete them together. Escape deselects.
- **Editing:** move, resize, rotate, flip, change layer order, duplicate (Ctrl+D) and delete (Del). The arrow keys nudge the selection.
- **Text boxes:** set the font, size in pt, colour, bold, italic, underline, alignment, outline and letter spacing.
  - Fonts: 29 to choose from, including free Google Fonts in serif, sans, handwriting/script, display and typewriter styles. A font downloads the first time it's used, and exports wait for it.
  - **Curve** bends a line of text into an arc, either ∩ or ∪.
  - **Label** puts a coloured, rounded tag behind straight text.
- **Groups:** select several items and press *Group* (Ctrl+G) so they always move, resize and rotate together. *Ungroup* is Ctrl+Shift+G.
  - Groups appear in Layers with their items listed underneath, and can be renamed by double-clicking.
  - Regenerating the random layout keeps groups.
  - Editing a sticker updates its copies inside groups too.
- **Background:** a solid colour, a two-colour gradient (vertical, horizontal, diagonal or radial), a paper texture (paper grain, linen, canvas or watercolour, generated in the app so no image files are needed), or your own image (fill, fit or tile, with opacity). The background is included in the export and saved with the project.
- **Print guides & framing:**
  - A **safe area** line shows where faces and text should stay, and items snap to it.
  - **Bleed** (2–5 mm, or 1/16–1/4 in) extends the background past the edge for print shops. A red dashed line marks where the print will be cut.
  - **Mat & frame preview** has white, cream or black mat presets and adjustable mat width, overlap and frame. It tells you the mat opening and frame size to order, and it's never included in the export.
- **Print size:** choose a preset (A5–A2, common cm and inch frame sizes), a custom physical size with DPI (150/200/300), or a plain pixel size. Changing the size scales the existing layout to fit.
- **Export:** PNG or JPEG at full print resolution with the DPI written into the file, or **PDF** at the exact physical size. With bleed, the PDF marks the trim size (TrimBox) for print shops. The export warns about stickers enlarged below about 150 DPI.

- **Snap & align:** while dragging, items snap to the page edges and centre and to other items' edges and centres, with magenta guide lines. Rotation snaps to 0°, 45°, 90° and so on when you are within 4°. Hold Alt to drag freely, or turn snapping off with *Snap & guides* in the toolbar. In the Selection panel, one item aligns to the page and several items align to each other. *Space ↔ / ↕* spreads 3 or more items evenly.
- **Undo / redo:** use the header buttons, Ctrl+Z, or Ctrl+Y / Ctrl+Shift+Z. They cover the print (stickers, text, layout), sticker edits, library changes and print settings. Each action is one step: a move, a delete, a button click, a whole random layout, a whole upload, or *Clear print*. Continuous input counts as one step when it ends: typing (when you leave the text box), dragging a colour picker (when you release it) or holding an arrow key (when you let go). History lasts for the browser session and is limited to 100 steps.
- **Project name:** click the name next to "Collage Studio" in the header to rename the project. It is saved with the project and shown in the browser tab, and it names downloaded files, for example `Summer-trip-2026.collage` and `Summer-trip-2026-30x40cm-300dpi.png`.
- **Save / load:**
  - *Autosave:* your work is saved in this browser (IndexedDB) about a second after each change and comes back when you reopen the page.
  - *Save project:* downloads a `.collage` file holding every image (original and edit steps), sticker settings, layout, text and print settings.
  - *Open…* continues from a `.collage` file, and *New* starts an empty collage and clears the autosave.

- **Phones & touch:** on screens narrower than 900 px, the side panels become bottom sheets opened from a tab bar (*Stickers*, *Print & layout*, *Edit selection*).
  - While something is selected, a quick bar offers *Edit text*, *Duplicate*, *Forward*, *Back*, *Delete* and *More…*.
  - Pinch with two fingers to resize and rotate the selected item. Rotation snaps to straight angles.
  - Resize handles are larger on touch screens.
  - Dialogs go full-screen.

## Files
- `server.js`: static server, search endpoint, and an image proxy so exports aren't blocked by CORS.
- `public/app.js`: UI, canvas (Fabric.js 5), library, editor and export.
- `public/pdf.js`: a minimal PDF writer (one page with the print as a high-quality JPEG).
- `public/backgrounds.js`: page backgrounds and generated paper textures.
- `public/layouts.js`: the layout styles (placement maths only).
- `public/imaging.js`: colour keying, trimming, outlines and DPI metadata.
- `public/project.js`: `.collage` file format and the IndexedDB autosave.

## About
This app's code was written with the help of AI coding tools. **No AI image generation is used anywhere.** Every image on a print is one you uploaded, pasted or picked from an image search. The app says this in its status bar.
