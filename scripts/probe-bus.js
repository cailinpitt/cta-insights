require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

async function main() {
  const key = process.env.CTA_BUS_KEY;
  if (!key) throw new Error('CTA_BUS_KEY missing');

  const route = process.argv[2] || '22';
  const url = 'https://www.ctabustracker.com/bustime/api/v3/getvehicles';
  const { data } = await axios.get(url, {
    params: { key, format: 'json', rt: route, tmres: 's' },
    timeout: 15000,
  });

  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
