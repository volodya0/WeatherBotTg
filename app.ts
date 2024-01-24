import mqtt from "mqtt";
import { Telegraf, Context, Markup } from "telegraf";
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

mqttClient.on("error", (error) => console.log("MQTT connection error:", error));
mqttClient.on("reconnect", () => console.log("MQTT client reconnecting..."));
mqttClient.on("offline", () => console.log("MQTT client is offline"));
mqttClient.on("connect", function () {
    console.log("MQTT client connected to broker");
    mqttClient.subscribe("measurements/WeatherTgBot", function (err) {
        if (!err) {
            mqttClient.publish("measurements/WeatherTgBot", "Hello from node");
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
            handleReceivedDevices(msgParsed.list_devices as string[]);
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

//const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

// Array to store user IDs
const userIDs: number[] = [];
const usersRequestedDevideList: number[] = [];
const usersRequestedInfo: number[] = [];

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
        "data": "${selectedDevice}",
    }`);

    // Answer the callback query (optional)
    ctx.answerCbQuery(`You selected: ${selectedDevice}, wait for updates`);
});

bot.launch();

function handleReceivedMeasurenents(msg: string, record: WeatherRecord){
    weatherHistory.addRecord(record);

     const notification = msg;
     console.log(
         `Send notification to telegram bot users, content="${notification}"  userIDs="${userIDs}"`
     );

     userIDs.forEach((userId) => {
         bot.telegram.sendMessage(
             userId,
             notification ?? "Error during generating a notification content"
         );
     });

    store();
};

function handleReceivedDevices(list_devices: string[]) {
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
            "Device liust is empty"
        );
        return;
    }

    const buttonLabels = list_devices.map((device) => {
        return Markup.button.callback(device, `choose_device_${device}`);
    });

    const keyboard = Markup.inlineKeyboard(buttonLabels, { columns: 1 });

    bot.telegram.sendMessage(
        userId,
        "Choose a device:",
        keyboard
    );
}

function handleReceivedInfo(info: Record<string, string>) {
    const userId = usersRequestedInfo.shift();
    if(!userId){
        return;
    }

    const message = `Info:\n\tSelected Device: ${info.selected_device}\n\tAbsolute Pressure: ${info.absolut_pressure} hPa\n\tAltitude: ${info.altitude} meters\n\tRSSI: ${info.rssi}\n\tTimestep: ${info.timestep}\n\tStatus: ${info.status}`;

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
        /*const completion = await openai.chat.completions.create({
            max_tokens: 1000,
            messages: [{ role: "system", content: prompt }],
            model: "gpt-3.5-turbo",
            temperature: 0.6,
        });*/

        //const message = completion.choices[0].message.content;
        const message = "";
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
