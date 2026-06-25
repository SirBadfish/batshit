export type MicrophoneDeviceOption = {
  id: string
  label: string
}

export type LoadMicrophoneDevicesOptions = {
  mediaDevices?: Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'> | null
  requestPermission?: boolean
}

function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

export async function loadMicrophoneDeviceOptions(
  options: LoadMicrophoneDevicesOptions = {}
): Promise<MicrophoneDeviceOption[]> {
  const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices
  if (!mediaDevices?.enumerateDevices) return []

  let permissionStream: MediaStream | null = null
  if (options.requestPermission && mediaDevices.getUserMedia) {
    try {
      permissionStream = await mediaDevices.getUserMedia({ audio: true })
    } finally {
      stopStream(permissionStream)
    }
  }

  const devices = await mediaDevices.enumerateDevices()
  const audioInputs = devices.filter((device) => device.kind === 'audioinput')
  let index = 1

  return audioInputs.map((device) => {
    const label = device.label?.trim() ? device.label.trim() : `Microphone ${index++}`
    return { id: device.deviceId, label }
  })
}
