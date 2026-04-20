require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

async function main() {
  const key = process.env.CTA_BUS_KEY;
  const pid = process.argv[2] || '3932';
  const { data } = await axios.get('https://www.ctabustracker.com/bustime/api/v3/getpatterns', {
    params: { key, format: 'json', pid },
    timeout: 15000,
  });

  const pattern = data['bustime-response']?.ptr?.[0];
  if (!pattern) return console.log(JSON.stringify(data, null, 2));
  console.log(`pid=${pattern.pid} rtdir=${pattern.rtdir} ln=${pattern.ln}ft points=${pattern.pt.length}`);
  console.log('first 3 points:', pattern.pt.slice(0, 3));
  console.log('last point:', pattern.pt[pattern.pt.length - 1]);
}

main().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
