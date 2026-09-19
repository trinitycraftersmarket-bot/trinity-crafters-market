const STORE_IDS = [
  "3b5b4234-8a01-4c7a-baf6-d1cd702a83ba",
  "c5cad53d-b8ed-405a-b642-8c3d3a219c70",
  "b1034a14-0de9-496e-b490-eea08d1f4979",
  "af14b019-423f-4223-b296-d960611d7e64",
  "ab57f2c7-1592-4bdc-bf5f-4e9e659d7acd",
  "15229cdf-5b1d-4fe5-ad64-0144f644a000",
];

export default async () => {
  const token = Netlify.env.get("GODADDY_PAT");
  if (!token) {
    return Response.json({ error: "GODADDY_PAT is not configured" }, { status: 500 });
  }

  const stores = [];
  for (const storeId of STORE_IDS) {
    try {
      const response = await fetch(`https://api.godaddy.com/v1/commerce/stores/${storeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => ({}));
      stores.push({
        storeId,
        ok: response.ok,
        status: response.status,
        displayName: body.displayName ?? body.name ?? null,
        lifecycleStatus: body.status ?? null,
        currency: body.currency ?? null,
      });
    } catch (error) {
      stores.push({ storeId, ok: false, error: String(error) });
    }
  }

  return Response.json({ stores }, {
    headers: { "Cache-Control": "no-store" },
  });
};

export const config = {
  path: "/api/godaddy-store-check",
};
