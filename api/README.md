# Live train data setup

The site requests live running status through `trains.php`. The PHP endpoint keeps the provider key on the server; never put that key in `script.js`, HTML, or a public configuration file.

1. Create an account with Railway Engine and obtain an API key from its dashboard.
2. Set the server environment variable `BHARATRAIL_RAILWAY_ENGINE_API_KEY` to that key.
3. For local development, run `node server.mjs` from the project folder and open `http://127.0.0.1:8082`. This server serves the site and handles its JSON API routes; opening the folder through a static-only server will not execute them. For deployment, use this Node server behind HTTPS or configure equivalent server-side routes.

Click the **Bharatrail** brand to open the admin sign-in. The default admin password is `196196`; set `BHARATRAIL_ADMIN_PASSWORD` on the server to replace it before public deployment. After signing in, upload and save a PNG, JPG, or WebP payment QR (maximum 3 MB). It is stored in `data/payment-settings.json` and shown to travelers after they enter their details and proceed. Payment proofs are stored under `data/payment-proofs/` for manual review. A submitted proof does not confirm a railway reservation or payment.

The full-screen admin workspace includes QR settings, phone-number search for submitted payment proofs, and a receipt maker. A proof’s transaction reference is supplied by the customer; screenshot text is not automatically read or verified. The maker exports a clearly marked Bharatrail receipt as printable PDF or editable HTML. It does not create an official railway ticket or PNR.

The endpoint supports live status (`type=status`), timetable (`type=schedule`), station-by-station route (`type=route`), coach/class composition (`type=coaches`), and itemised fare quotes (`type=fare`) by train number. Fare requests require source and destination station codes, class, quota, and journey date. Live status and fare responses display provider freshness when supplied. The provider documents a 60-request-per-minute free key limit; the fare viewer requests classes sequentially and stops when rate limited. If no key is configured or the provider cannot respond, the browser shows a stored timetable route separately and never treats it as a live location.

Railway Engine is an independent provider and is not Indian Railways, IRCTC, CRIS, or NTES. Check its current terms and data coverage before using it in a commercial booking service. The nationwide train and station search uses the licensed local snapshot documented in `../data/README.md`. Fare results are quotes, not ticket inventory or booking confirmation. The provider docs do not expose a live seat availability or ticket booking endpoint.
