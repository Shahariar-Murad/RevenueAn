# Revenue & Approval Dashboard

Static Vercel-ready dashboard for:
- revenue analysis across BridgerPay, ZEN, and PayProcc
- BridgerPay approval analysis with retry-safe unique merchant order logic

## Upload files
- BridgerPay CSV
- ZEN CSV
- PayProcc CSV

## BridgerPay approval logic
- Uses `merchantOrderId` as the unique transaction key (fallbacks applied if missing)
- Approval ratio = approved unique orders / total unique orders
- Approved if any attempt for the unique order has status `approved`, `captured`, or `successful`
- PSP type mapping:
  - Confirmo → Crypto
  - PayPal → P2P
  - everything else → Card

Host on Vercel by importing the GitHub repo.
