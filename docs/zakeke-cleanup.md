# Zakeke cleanup — get all 97 price-list products customizable (2026-10-29)

Zakeke's plan allows **100 published products** and is full. The price list is 97
products, 63 of them already in Zakeke, so 34 more need slots. Of the 37 published
products that are NOT on the price list, **delete 34 and keep 3** -> 97 + 3 = 100.
Nothing has been deleted by me; Zakeke deletions are permanent, so they are yours to do in
admin.zakeke.com (Products -> select -> Delete). Product ids are Zakeke's own.

## A. Keep these 3 (no equivalent in the price list — swap if you prefer others)
| Product | Zakeke id | Type |
|---|---|---|
| Carhartt Quilted-Flannel-Lined Duck Active Jacket | 10060883 | older live |
| Ceramic Mug | 10060901 | older live |
| Medium Cotton Canvas Tote Bag | 10060900 | older live |

## B. Delete these 34 published products
Order matters only for the older LIVE ones: they stop being customizable (and have no buy
button) the moment they are deleted from Zakeke, so tell me when you're about to do the
live ones and I'll draft them on the store first.
| Product | Zakeke id | Type |
|---|---|---|
| Bella + Canvas Women's Relaxed Heather CVC V-Neck Tee | 10060837 | older live |
| Custom Gildan Heavy Blend Hoodie | 10060842 | older live |
| Gildan - Heavy Cotton 100% Cotton T-Shirt | 10008385 | older live |
| Gildan Heavy Blend Fleece Sweatshirt | 10060839 | older live |
| Jerzees NuBlend Fleece Sweatshirt | 10060876 | older live |
| Port & Company Core Blend Jersey Knit Polo | 10008535 | older live |
| Port & Company Core Cotton Long Sleeve T-shirt | 10008527 | older live |
| Port & Company Core Cotton T-shirt | 611089 | older live |
| Port & Company Core Fleece Pullover Hoodie | 10008394 | older live |
| SnapBack Hats | 606600 | older live |
| Sport-Tek PosiCharge Tough Mesh Full-Button Jersey | 10060844 | older live |
| Trucker Hats | 606601 | older live |
| District Distressed Cap. DT600 | 10093236 | original SanMar (live) |
| Gildan - Ultra Cotton 100% US Cotton Tank Top. 2200 | 10093234 | original SanMar (live) |
| Gildan Heavy Blend Sweatpant. 18200 | 10093233 | original SanMar (live) |
| Gildan Women's Ultra Cotton 100% US Cotton T-Shirt. 2000L | 10093241 | original SanMar (live) |
| Gildan Youth Heavy Blend Crewneck Sweatshirt. 18000B | 10093231 | original SanMar (live) |
| Port & Co Women's Long Sleeve Value Denim Shirt. LSP10 | 10093232 | original SanMar (live) |
| Port & Co Women's Short Sleeve Value Denim Shirt. LSP11 | 10093239 | original SanMar (live) |
| Port Authority Microfleece Vest. F226 | 10093245 | original SanMar (live) |
| Port Authority Team Jacket. JP56 | 10093230 | original SanMar (live) |
| Port Authority Unstructured Brushed Twill Cap. BTU | 10093229 | original SanMar (live) |
| Port Authority Value Fleece Vest. F219 | 10093238 | original SanMar (live) |
| Port Authority ® - Ideal Twill Jumbo Tote. B300 | 10093248 | original SanMar (live) |
| Port Authority ® Ideal Twill Grocery Tote. B100 | 10093247 | original SanMar (live) |
| Sport-Tek Dry Zone Nylon Cap. STC10 | 10093243 | original SanMar (live) |
| Sport-Tek Sport-Wick Fleece 1/4-Zip Pullover. F243 | 10093237 | original SanMar (live) |
| Sport-Tek Super Heavyweight Crewneck Sweatshirt. F280 | 10093240 | original SanMar (live) |
| Sport-Tek V-Neck Raglan Wind Shirt. JST72 | 10093244 | original SanMar (live) |
| Sport-Tek Women's Dri-Mesh V-Neck Polo. L469 | 10093235 | original SanMar (live) |
| Sport-Tek Women's Dry Zone Raglan Accent Polo. L475 | 10093242 | original SanMar (live) |
| Port & Co Long Sleeve Value Denim Shirt. SP10 | 10093212 | orphan (no Shopify product) |
| Limited Time Offer: Premium Tees for Only $15 | 10060666 | other draft |
| Port & Co Long Sleeve Value Denim Shirt. SP10 | 10093249 | other draft |

## C. Delete these 3 unpublished products (orphans / old duplicates, not counted but still taking space)
| Product | Zakeke id | Type |
|---|---|---|
| Port Authority - Ideal Twill Jumbo Tote. B300 | 10093191 | orphan (no Shopify product) |
| Port Authority Ideal Twill Grocery Tote. B100 | 10093190 | orphan (no Shopify product) |
| Port & company KP55 | 10054929 | other draft |

After deleting, tell me and I will connect the 35 waiting price-list products
(`node scripts/zakeke-connect-v2.js --which batch`) and publish them.
