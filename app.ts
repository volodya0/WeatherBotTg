import mqtt from "mqtt";
import { Telegraf, Context } from "telegraf";
import { WeatherRecord } from "./models";
import { OpenAI } from "openai";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL!, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
});

mqttClient.on("error", (error) => console.log("Connection error:", error));
mqttClient.on("reconnect", () => console.log("Client reconnecting..."));
mqttClient.on("offline", () => console.log("Client is offline"));
mqttClient.on("connect", function () {
    console.log("Client connected to broker");
    mqttClient.subscribe("measurements", function (err) {
        if (!err) {
            mqttClient.publish("measurements", "Hello from node");
        } else {
            console.log("ERROR CONNECTING CLIENT");
            console.log(err);
        }
    });
});

mqttClient.on("message", async function (topic, message) {
    // Assume the message is a JSON string with weather data
    try {
        const msg = message.toString();

        console.log(
            `Client received a message, topic="${topic}"  message="${msg}"`
        );

        let weatherRecord;
        try {
            weatherRecord = JSON.parse(msg) as WeatherRecord;
            if (
                !(weatherRecord instanceof Object) ||
                !weatherRecord.humidity ||
                !weatherRecord.pressure ||
                !weatherRecord.temperature
            ) {
                throw new Error();
            }
        } catch {
            console.log(`Failed to parse record, message="${msg}"`);
            return;
        }

        weatherHistory.addRecord(weatherRecord);

        const notification = await requestWeatherNotification();

        console.log(
            `Send notification to users, content="${notification}"  userIDs="${userIDs}"`
        );

        // Send notification to all subscribed users
        userIDs.forEach((userId) => {
            bot.telegram.sendMessage(
                userId,
                notification ?? "Error during generating a notification content"
            );
        });

        store();
    } catch (e) {
        console.error("Error parsing MQTT message:", e);
    }
});

////////////////////////////////////////////////////////////////////////////////////////////////////

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

// Array to store user IDs
let userIDs: number[] = [];

bot.start((ctx: Context) => {
    ctx.reply("Привіт, тепер ти будеш отримуати опис змін показників!");
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

bot.help((ctx: Context) => ctx.reply("Send me a sticker"));

bot.launch();

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
        prompt += `The current weather data is: temperature ${record.temperature}°C, humidity ${record.humidity}%, and pressure ${record.pressure} hPa.`;
    } else if (lastRecords.length > 1) {
        const [previousRecord, currentRecord] = lastRecords;
        prompt += `Previously, the weather was: temperature ${previousRecord.temperature}°C, humidity ${previousRecord.humidity}%, and pressure ${previousRecord.pressure} hPa. Now, the temperature is ${currentRecord.temperature}°C, the humidity is ${currentRecord.humidity}%, and the pressure is ${currentRecord.pressure} hPa. Describe the changes in weather conditions and provide a forecast for the upcoming changes.`;
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
