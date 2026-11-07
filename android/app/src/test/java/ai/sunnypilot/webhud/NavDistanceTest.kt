package ai.sunnypilot.webhud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** [HudListener.hasDistance]: an app like ABRP counts as guiding only while its notification gives a distance. */
class NavDistanceTest {
    @Test
    fun aTurnsDistanceCounts() {
        for (t in listOf("300 m", "In 300 m turn right", "0.4 mi", "Turn left in 1,2 km", "500 ft · Main St", "250 meters", "2 miles"))
            assertTrue(t, HudListener.hasDistance(listOf(t)))
    }

    @Test
    fun timesPercentagesAndWordsDont() {
        for (t in listOf("", "ABRP", "Live data active", "45 min", "Arrive 14:32 with 45%", "Planning route…", "2 h 10 min"))
            assertFalse(t, HudListener.hasDistance(listOf(t)))
    }
}
