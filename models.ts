export interface WeatherRecord {
    temperature: number;
    humidity: number;
    pressure: number;
    timestamp?: Date;
}

export interface CommonInfo {
    absolut_pressure: number;
    altitude: number;
    selected_device: string;
    rssi: number;
    timestep: string;
    status: string;
}

export interface DeviceInfo {
    name: string;
    status: 'Online' | 'Offline';
}