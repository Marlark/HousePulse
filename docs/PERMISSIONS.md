# Permission justification: `homey:manager:api`

Paste the text below into the App Store submission when Athom asks why the app needs this permission.

---

HousePulse is a dashboard widget that visualises the energy flows in a home: grid, solar, EV charger, home battery, electric car and home consumption. These values come from devices that belong to *other* apps (energy meters, inverters, chargers, batteries and cars from many brands). The Web API is the only way for an app to read them, so `homey:manager:api` is required for the app's core function.

**What the app reads**

- `devices`: the list of devices and the values of energy capabilities only: `measure_power` (and its sub-capabilities, e.g. `measure_power.solar`), `measure_battery`, and the `meter_power` capabilities named in the device's `energyObj`. It subscribes to these capabilities, and to device availability, for the devices the user selected in the widget settings.
- `devices`: `class`, `virtualClass` and `energyObj`, to suggest suitable devices in the widget settings and to pick the right kWh meters, brand-independently.
- `zones`: zone names, only to show where a device is in the device picker.
- `energy.getLiveReport`: Homey's own grid figure, only to recognise which of several meters is the whole-home meter.

**What the app does not do**

- It never controls devices or changes any capability, setting, flow, zone or other data in Homey.
- It makes no network requests. All data stays on the Homey.
- It stores only its own state in app settings: which devices the widgets use and today's kWh totals per device.

**Scope and resource use**

- Listeners are only created for devices the user selected (or that the widget suggested), and released when the user removes them from the widget, or after 7 days without any widget showing them.
- Capability updates are pushed to the widget in real time; there is no polling of devices.

**Diagnostics**

The app settings page shows a diagnostics report (device classes, energy metadata and chosen meters) so users of other brands can report problems. It is only shown to the user, never sent anywhere, and can hide device and zone names.
