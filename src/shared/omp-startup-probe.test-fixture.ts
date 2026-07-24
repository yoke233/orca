// Oh My Pi 17.1.0 writes these separately and in this order during TUI startup.
export const OMP_17_1_0_OSC11_QUERY = '\x1b]11;?\x07'
export const OMP_17_1_0_DA1_SENTINEL = '\x1b[c'
export const OMP_17_1_0_MODE_2031_SUBSCRIBE = '\x1b[?2031h'
export const OMP_17_1_0_COLOR_STARTUP_BYTES =
  OMP_17_1_0_OSC11_QUERY + OMP_17_1_0_DA1_SENTINEL + OMP_17_1_0_MODE_2031_SUBSCRIBE
