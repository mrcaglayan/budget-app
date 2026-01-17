// services/scheduler.js
const cron = require('node-cron');
const { sendTaskNotificationEmails } = require('./emailService');

// Optional: gate scheduling to one PM2 instance via env var
if (process.env.ENABLE_SCHEDULER === 'true') {
  cron.schedule('0 9 * * *', async () => {
    try {
      await sendTaskNotificationEmails();
      console.log('Scheduled email notifications sent at 09:00 (Asia/Kabul)');
    } catch (err) {
      console.error('Error sending scheduled emails at 09:00:', err);
    }
  }, { timezone: 'Asia/Kabul' });
} else {
}
