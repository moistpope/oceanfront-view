import javax.inject.Inject

plugins {
    id("com.android.application")
}

// The page and its files ship in the APK: copied here from the checkout at build time. android/ sits
// beside static/ (the page), third_party/ (three.js, the car model) and dbc/ (the three DBCs).
abstract class SyncWebAssets @Inject constructor(private val fs: FileSystemOperations) : DefaultTask() {
    @get:InputDirectory abstract val staticDir: DirectoryProperty
    @get:InputDirectory abstract val threeDir: DirectoryProperty
    @get:InputDirectory abstract val modelsDir: DirectoryProperty
    @get:InputDirectory abstract val dbcDir: DirectoryProperty
    @get:OutputDirectory abstract val outDir: DirectoryProperty

    @TaskAction
    fun run() {
        fs.sync {
            into(outDir.dir("www"))
            from(staticDir)
            from(threeDir) { into("vendor") }
            from(modelsDir) { into("models") }
            from(dbcDir) { into("dbc") }
        }
    }
}

val repoRoot = rootProject.projectDir.resolve("..")
val syncWebAssets = tasks.register<SyncWebAssets>("syncWebAssets") {
    description = "Copies the HUD page, three.js, the car model and the DBCs into the APK's assets"
    staticDir.set(repoRoot.resolve("static"))
    threeDir.set(repoRoot.resolve("third_party/three"))
    modelsDir.set(repoRoot.resolve("third_party/models"))
    dbcDir.set(repoRoot.resolve("dbc"))
    outDir.set(layout.buildDirectory.dir("generated/webhud_assets"))
}

android {
    namespace = "ai.sunnypilot.webhud"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.sunnypilot.webhud"
        minSdk = 26
        targetSdk = 36
        versionCode = 10
        versionName = "1.5"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // sideloaded onto the car's own screen, never published: the debug key keeps installs simple
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    packaging {
        // the CAN helper ships as a .so so it installs into nativeLibraryDir, the one place an app may
        // exec from; useLegacyPackaging keeps it a real file on disk rather than mapped from the APK
        jniLibs.useLegacyPackaging = true
    }

    androidResources {
        // stored as they are, so LocalServer can stream them from a file descriptor (the model is ~25 MB)
        noCompress += listOf("glb", "js", "css", "html", "dbc", "json", "svg", "ico")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true   // android.util.Log in code under test
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(syncWebAssets) { it.outDir }
    }
}

dependencies {
    implementation("com.github.mwiede:jsch:2.28.8")   // SSH to the comma (CommaSsh): pure Java, BSD
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")   // the real org.json; android.jar only has stubs
}
