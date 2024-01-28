import mqtt from "mqtt";
import { Telegraf, Context, Markup } from "telegraf";
import { CommonInfo, DeviceInfo, WeatherRecord } from "./models";
import { OpenAI } from "openai";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL!, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
});

mqttClient.on("error", (error) => console.log("MQTT connection error:", error));
mqttClient.on("reconnect", () => console.log("MQTT client reconnecting..."));
mqttClient.on("offline", () => console.log("MQTT client is offline"));
mqttClient.on("connect", function () {
    console.log("MQTT client connected to broker");
    mqttClient.subscribe("measurements/WeatherTgBot", function (err) {
        if (!err) {
            mqttClient.publish("measurements/WeatherTgBot", "Connected MQTT client for bot");
        } else {
            console.log("ERROR CONNECTING CLIENT");
            console.log(err);
        }
    });
});

mqttClient.on("message", async function (topic, message) {
    try {
        const msgString = message.toString();

        console.log(
            `MQTT client received a message, topic="${topic}"  message="${msgString}"`
        );

        let msgParsed;
        try {
            msgParsed = JSON.parse(msgString);
        } catch {
            console.log(`Failed to parse, invalid JSON data, message="${msgString}"`);
            return;
        }


        if (
            msgParsed.humidity !== undefined &&
            msgParsed.pressure !== undefined &&
            msgParsed.temperature !== undefined 
        ) {
            handleReceivedMeasurenents(msgString, msgParsed as  WeatherRecord)
        } else if (msgParsed.list_devices && Array.isArray(msgParsed.list_devices)){
            handleReceivedDevices(msgParsed.list_devices as DeviceInfo[]);
        }else if (msgParsed.selected_device){
            handleReceivedInfo(msgParsed)
        }else {
            console.error("Cannot recognise message content");
        }

       
    } catch (e) {
        console.error("Error during handling MQTT message:", e);
    }
});


////////////////////////////////////////////////////////////////////////////////////////////////////

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

// Array to store user IDs
const userIDs: number[] = [];
const usersRequestedDevideList: number[] = [];
const usersRequestedInfo: number[] = [];

bot.start((ctx: Context) => {
    ctx.reply("Привіт, тепер ти будеш отримуати опис змін показників вибраного пристрою!");
    // Add user ID to the array
    if (ctx.from?.id && !userIDs.includes(ctx.from.id)) {
        console.log(
            `New bot start, id="${ctx.from.id}" userName="${
                ctx.from.username
            }"  ctx="${JSON.stringify(ctx.from)}}"`
        );

        userIDs.push(ctx.from.id);
        store();
    }
});

bot.telegram.setMyCommands([
    {
      command: 'info',
      description: 'Виводить детальної інформації, такі як: статус і час.',
    },
    {
      command: 'list',
      description: 'Виводить список пристроїв з яких можна отримувати дані, а також їх статус. Зяких можна вибрати пристрій.',
    },
    {
      command: 'start',
      description: 'Запуск бота',
    },
    {
      command: 'help',
      description: 'Опис',
    }
  ]);

bot.help((ctx: Context) => ctx.reply("Вітаю! Даний бот призначений для отримання інформації про погоду та стан пристроїв. Ось список доступних команд:\n1. /start - Розпочніть взаємодію з ботом, щоб отримувати щоденні оновлення погоди та іншу інформацію.\n2. /info - Використовуйте цю команду, щоб отримати інформацію про стан певного пристрою. Введіть `/info`, а потім виберіть пристрій зі списку, щоб отримати подробиці.\n3. /list - Використовуйте команду `/list`, щоб переглянути список доступних пристроїв і їхніх параметрів. Виберіть пристрій, щоб отримати більше інформації.\n4. /help - Використовуйте цю команду, щоб отримати додаткову інформацію про можливості бота та команди.\nБот також автоматично повідомляє користувачів про оновлення погоди та інші важливі події. Не соромтеся використовувати команди та отримувати корисну інформацію від цього бота!"));

bot.command("info", (ctx) => {
    usersRequestedInfo.push(ctx.from.id);
    mqttClient.publish("measurements/RequestSetting", `{
        "sendler": "TgBot",
        "requestCommand": "information"
    }`);
});

bot.command("list", (ctx) => {
    usersRequestedDevideList.push(ctx.from.id);
    mqttClient.publish("measurements/RequestSetting", `{
        "sendler": "TgBot",
        "requestCommand": "listDevices"
    }`);
});

bot.action(/^choose_device_(.*)$/, (ctx) => {
    const selectedDevice = ctx.match[1]; 
    // const userId = ctx.from!.id;

    mqttClient.publish("measurements/RequestSetting", `{
        "sendler": "TgBot",
        "requestCommand": "changeDevice",
        "data": "${selectedDevice}"
    }`);

    bot.telegram.sendMessage(
        ctx.from!.id,
        `Вибрано пристрій: ${selectedDevice}, Очікуйте оновлень`
    );
});

bot.launch();

async function handleReceivedMeasurenents(msg: string, record: WeatherRecord){
    weatherHistory.addRecord(record);

     const notification = process.env.USE_GPT === 'true' ? await requestWeatherNotification() : msg;
     console.log(
         `Send notification to telegram bot users, content="${notification}"  userIDs="${userIDs}"`
     );
     console.log(notification)
     mqttClient.publish("measurements/RequestSetting", `{
        "sendler": "WebServ",
        "requestCommand": "sendMessage",
        "data": "${notification}"
    }`);
     userIDs.forEach((userId) => {
         bot.telegram.sendMessage(
             userId,
             notification ?? "Виникла помилка при генерації контенту повідомлення, актуальні показникики: \n" + msg,
         );
     });

    store();
};

function handleReceivedDevices(list_devices: DeviceInfo[]) {
    const userId = usersRequestedDevideList.shift();
    if(!userId){
        return;
    }

    console.log(
        `Send device list to telegram bot user, devices="${list_devices}"  userID="${userId}"`
    );

    if (list_devices.length === 0) {
        bot.telegram.sendMessage(
            userId,
            "Отримано пустий список пристроїв"
        );
        return;
    }

    const buttonLabels = list_devices.map((device) => {
        return Markup.button.callback(`${device.status === 'Online' ? '✅' : '✖️'} ${device.name}` , `choose_device_${device.name}`);
    });

    const keyboard = Markup.inlineKeyboard(buttonLabels, { columns: 1 });

    bot.telegram.sendMessage(
        userId,
        "Виберіть пристрій:",
        keyboard
    );
}

function handleReceivedInfo(info: CommonInfo) {
    const userId = usersRequestedInfo.shift();
    if(!userId){
        return;
    }

    const message = `Інформація:\n\tВибраний пристрій: ${info.selected_device}\n\tАбсолютний тиск: ${info.absolut_pressure} Па\n\tВисота: ${info.altitude} метрів\n\tRSSI: ${info.rssi}\n\tЧасовий штамп: ${info.timestep}\n\tСтатус: ${info.status}`;

    console.log(
        `Send info list to telegram bot user, message="${message}"  userID="${userId}"`
    );

    bot.telegram.sendMessage(
        userId,
        message,
    );
}


////////////////////////////////////////////////////////////////////////////////////////////////////

async function requestWeatherNotification(): Promise<string | undefined> {
    const prompt = createOpenAIPrompt();

    try {
        const completion = await openai.chat.completions.create({
            max_tokens: 1000,
            messages: [{ role: "system", content: prompt }],
            model: "gpt-3.5-turbo",
            temperature: 0.6,
        });

        const message = completion.choices[0].message.content;
        return message ?? undefined;
    } catch (error) {
        console.error("Error calling OpenAI API:", error);
        throw error;
    }
}

function createOpenAIPrompt() {
    const lastRecords = weatherHistory.getLastRecords(2);
    let prompt =
        "Please provide a short weather update and a suggestion for the day in Ukrainian language. ";

    if (lastRecords.length === 1) {
        const record = lastRecords[0];
        prompt += `The current weather data is: temperature ${record.temperature}°C, humidity ${record.humidity}%, and pressure ${record.pressure} Pa. Max size is 200 characters.`;
    } else if (lastRecords.length > 1) {
        const [previousRecord, currentRecord] = lastRecords;
        prompt += `Previously, the weather was: temperature ${previousRecord.temperature}°C, humidity ${previousRecord.humidity}%, and pressure ${previousRecord.pressure} Pa. Now, the temperature is ${currentRecord.temperature}°C, the humidity is ${currentRecord.humidity}%, and the pressure is ${currentRecord.pressure} Pa. Describe the changes in weather conditions and provide a forecast for the upcoming changes. Max size is 200 characters.`;
    }

    return prompt;
}

////////////////////////////////////////////////////////////////////////////////////////////////////

class WeatherHistory {
    private records: WeatherRecord[] = [];

    constructor() {
        this.records = [];
    }

    public setData(data: WeatherRecord[]) {
        this.records = data ?? [];
    }

    public addRecord(record: WeatherRecord): void {
        this.records.push(record);
    }

    public getLastRecord(): WeatherRecord | null {
        if (this.records.length === 0) return null;
        return this.records[this.records.length - 1];
    }

    public getLastRecords(count = 2) {
        // Get the last 'count' records, but do not exceed the array length
        return this.records.slice(Math.max(this.records.length - count, 0));
    }

    public getData(): WeatherRecord[] {
        return this.records;
    }

    // Additional methods...
}

const weatherHistory = new WeatherHistory();

////////////////////////////////////////////////////////////////////////////////////////////////////

function init() {
    const filePath = path.join(process.cwd(), "data.json");
    if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (Array.isArray(data.WeatherHistory)) {
            weatherHistory.setData(data.WeatherHistory);
        }
        if (Array.isArray(data.Users)) {
            userIDs.push(...data.Users);
        }
    }

    setInterval(() => console.log('tick'), 10_000)
}

function store() {
    const filePath = path.join(process.cwd(), "data.json");
    fs.writeFileSync(
        filePath,
        JSON.stringify(
            {
                WeatherHistory: weatherHistory.getData() ?? [],
                Users: userIDs ?? [],
            },
            null,
            2
        ),
        "utf8"
    );
}

setTimeout(() => init(), 1000);
