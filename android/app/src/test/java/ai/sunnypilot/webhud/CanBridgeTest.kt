package ai.sunnypilot.webhud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CanBridgeTest {
    @Test
    fun onlyAChangedPayloadIsASignOfLife() {
        assertTrue(CanBridge.isSignOfLife(null, "0011223344556677"))                 // the first frame for an ID
        assertTrue(CanBridge.isSignOfLife("0011223344556677", "0111223344556677"))   // its alive counter moved
        assertFalse(CanBridge.isSignOfLife("0011223344556677", "0011223344556677"))  // the helper's repeat
    }

    /** The helper's output as the car falls asleep: the bus goes quiet, its keepalive goes on. */
    @Test
    fun theKeepaliveDoesNotKeepABusAwake() {
        val held = HashMap<String, String>()   // what readLoop keeps in `latest`, per ID
        var seen = -1L                         // and in `busSeen`
        fun line(at: Long, addr: String, data: String) {
            if (CanBridge.isSignOfLife(held.put(addr, data), data)) seen = at
        }
        // awake for 2 s: 0x335 holds a steady value, 0x234's alive counter moves every 100 ms
        line(0, "335", "0000004000000000")
        for (i in 0 until 20) line(i * 100L, "234", "%02x00000000000000".format(i % 15))
        assertEquals(1900L, seen)
        // then nothing on the bus; the helper reprints each ID's last frame once it's a second old
        val counter = held.getValue("234")
        for (t in 1000L..60_000L step 1000) {
            line(t, "335", "0000004000000000")
            if (t >= 3000) line(t - 100, "234", counter)
        }
        assertEquals("the last change, not the last line", 1900L, seen)
        // and when it wakes, the first change counts again
        line(61_000, "234", "%02x00000000000000".format(5))
        assertEquals(61_000L, seen)
    }
}
