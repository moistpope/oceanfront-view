package ai.sunnypilot.webhud

import org.junit.Assert.assertEquals
import org.junit.Test

class CanBusMapTest {
    private val opi = mapOf("can1" to "IBUS1", "can2" to "IBUS2")
    private val rock = mapOf("can0" to "IBUS1", "can1" to "IBUS2")

    @Test fun orangePiNumbering() = assertEquals(opi, busMap(setOf("lo", "wlan0", "can1", "can2")))
    @Test fun rock5cNumbering() = assertEquals(rock, busMap(setOf("lo", "wlan0", "can0", "can1")))
    @Test fun noCanFallsBackToOrangePi() = assertEquals(opi, busMap(setOf("lo")))
}
