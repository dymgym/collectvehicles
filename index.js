// index.js
// =========================================

// 1) Импортируем зависимости
import express from 'express';
import fetch   from 'node-fetch';
import admin   from 'firebase-admin';

// Глобальные ловцы
process.on('unhandledRejection', (reason, promise) => {
  console.error('❗ Unhandled Rejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('❗ Uncaught Exception:', err);
});

// 2) Инициализируем Firebase Admin SDK один раз
//    Подставьте сюда ваш реальный URL из консоли Firebase → Realtime Database → Rules:
const DATABASE_URL = 'https://bolt-abd52-default-rtdb.europe-west1.firebasedatabase.app';

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: DATABASE_URL
  });
}

// 3) Параметры Bolt API и RTDB
const VEHICLES_PATH = '/heatmap/vehicles';

// Статический центр и viewport
const CENTER = { lat: 59.342, lng: 27.512 };
const VIEWPORT = {
  north_east: { lat: 59.45, lng: 27.80 },
  south_west: { lat: 59.19, lng: 27.12 }
};

// Заголовки и тело для Bolt poll
const BOLT_URL_BASE = 'https://user.live.boltsvc.net/mobility/search/poll';
const BOLT_HEADERS = {
  'Authorization': 'Basic KzM3MjU4NTI5ODI3OjVkYTExMjNiLTFiNGQtNDhlNS1hMWE4LTBmN2FmOGUzZGViYw==',
  'Content-Type':  'application/json; charset=UTF-8'
};
const BOLT_BODY = {
  stage:             'category_selection',
  payment_method:    { id: 'cash', type: 'default' },
  pickup_stop:       { ...CENTER, is_confirmed: true },
  destination_stops: [],
  viewport:          VIEWPORT
};

// 4) Функция один раз дергает API и пушит результаты
async function collectOnce() {
  try {
    const db   = admin.database();
    const data = await fetch(
      `${BOLT_URL_BASE}?` + new URLSearchParams({
        version:           'CA.120.0',
        deviceId:          'dUdQ7W7qRvOz0Pl6swSSju',
        device_name:       'Googlesdk_gphone64_x86_64',
        device_os_version: '13',
        channel:           'googleplay',
        brand:             'bolt',
        deviceType:        'android',
        country:           'ee',
        language:          'en',
        gps_lat:           CENTER.lat.toString(),
        gps_lng:           CENTER.lng.toString(),
        gps_accuracy_m:    '5.0',
        gps_age:           '0'
      }),
      {
        method: 'POST',
        headers: BOLT_HEADERS,
        body: JSON.stringify(BOLT_BODY)
      }
    );

    if (!data.ok) {
      console.error(`Bolt API HTTP ${data.status}`);
      return;
    }

    const json   = await data.json();
    const modes  = json.data?.vehicles || {};
    const unique = new Map();

    // Дедупликация по ID
    for (const mode of Object.values(modes)) {
      for (const arr of Object.values(mode)) {
        if (!Array.isArray(arr)) continue;
        for (const v of arr) {
          if (
            v &&
            typeof v.id  === 'string' &&
            typeof v.lat === 'number' &&
            typeof v.lng === 'number'
          ) {
            unique.set(v.id, {
              id:      v.id,
              lat:     v.lat,
              lng:     v.lng,
              bearing: typeof v.bearing === 'number' ? v.bearing : 0
            });
          }
        }
      }
    }

    const vehicles = Array.from(unique.values());
    await db.ref(VEHICLES_PATH).set({
      timestamp: admin.database.ServerValue.TIMESTAMP,
      count:     vehicles.length,
      list:      vehicles
    });

    console.log(`✓ Saved ${vehicles.length} vehicles @ ${new Date().toISOString()}`);
  } catch (err) {
    // Ловим любые ошибки внутри collectOnce, логируем и не кидаем дальше
    console.error('❗ collectOnce error (ignored):', err);
  }
}

// 5) Express-сервер для Cloud Run — health check + запуск фонового цикла
const app  = express();
const PORT = process.env.PORT || 8080;

app.get('/', (_req, res) => res.status(200).send('OK'));

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}, starting vehicle collection every 5s…`);
  collectOnce();                   // первый вызов сразу
  setInterval(collectOnce, 5_000); // далее каждые 5 секунд
});