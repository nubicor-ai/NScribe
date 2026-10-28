# Synthetic audio for the mic/VAD tests (not speech recognition tests: a tone pattern cannot say words).
import wave, struct, math, random, sys
R = 16000
def write(name, samples):
    with wave.open(name, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(R)
        w.writeframes(b''.join(struct.pack('<h', max(-32767, min(32767, int(s * 32767)))) for s in samples))
def speech(sec, amp=0.25):
    out = []
    for i in range(int(sec * R)):
        t = i / R
        env = 0.65 + 0.35 * math.sin(2 * math.pi * 4 * t)            # syllable-like wobble, never silent
        v = sum(math.sin(2 * math.pi * f * t) / (k + 1) for k, f in enumerate((140, 280, 420, 700, 1100)))
        out.append(amp * env * v / 2.2)
    return out
def quiet(sec, amp=0.001):
    return [amp * (random.random() - .5) * 2 for _ in range(int(sec * R))]
random.seed(1)
d = sys.argv[1]
write(d + '/bursts.wav', (speech(4) + quiet(2)) * 12)            # 4 s speech, 2 s pause, repeated
write(d + '/continuous-70s.wav', speech(70))                      # one long dictation with no pause
write(d + '/silence.wav', quiet(20))                              # empty audio
write(d + '/noise.wav', quiet(20, 0.006))                         # steady low background noise
