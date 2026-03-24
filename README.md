# Revenue Dashboard (Vercel Ready)

This is a static dashboard you can host on **Vercel through GitHub**.

## Included features
- Country-wise revenue
- PSP country-wise revenue
- Revenue percentage of each country among total revenue
- World map visualization
- Top countries and top PSP-country pairs
- CSV upload boxes to replace the sample files in-browser

## Files already included
Placeholders are already wired to these CSV files:
- `data/bridgerpay.csv`
- `data/zen.csv`
- `data/payprocc.csv`

## Revenue logic
- **BridgerPay:** approved rows using `amount`
- **ZEN:** `Purchase` rows using `stl_amount`
- **PayProcc:** successful `sale` rows using `Applied Amount` first, else `Amount`

## Deploy on Vercel via GitHub
1. Create a new GitHub repository.
2. Upload all files from this folder.
3. Go to Vercel and click **Add New Project**.
4. Import the GitHub repository.
5. Vercel will detect it as a static site.
6. Click **Deploy**.

## Update later
You can either:
- replace the CSV files inside the `data` folder, or
- use the upload boxes inside the dashboard UI.
