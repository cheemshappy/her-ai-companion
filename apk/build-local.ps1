# 不依赖 Gradle 的 APK 构建：aapt2 + javac + d8 + zipalign + apksigner
# ⚠️ 为什么先复制到 D:\ai-tools\amadeus 再编译：
#    aapt2/d8 这些原生 exe 收中文路径会挂（argv 走 ANSI），
#    所以全部在纯 ASCII 目录里构建，最后只把成品 APK 拷回 dist/。
# 用法：pwsh -File apk\build.ps1
param([string]$StageRoot = (Join-Path $env:TEMP 'amadeus-build-public'))
$ErrorActionPreference = 'Stop'

$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$ROOT = Split-Path -Parent $HERE
$JAVA_HOME = $env:JAVA_HOME
if(-not $JAVA_HOME){throw 'Set JAVA_HOME to JDK 17'}
$SDK = if($env:ANDROID_HOME){$env:ANDROID_HOME}else{$env:ANDROID_SDK_ROOT}
if(-not $SDK){throw 'Set ANDROID_HOME to Android SDK 34'}
$BT = Join-Path $SDK 'build-tools\34.0.0'
$AJ = Join-Path $SDK 'platforms\android-34\android.jar'

$STAGE = [System.IO.Path]::GetFullPath($StageRoot)
if ($STAGE -match '[^\x00-\x7F]' -or (Split-Path -Leaf $STAGE) -notmatch '^amadeus-build(?:-[A-Za-z0-9-]+)?$') { throw '构建目录必须为 ASCII 路径，末级目录名须为 amadeus-build 或 amadeus-build-xxx' }
$DIST = Join-Path $ROOT 'dist'
$signingDirectory = Join-Path $HERE '.local-signing'
New-Item -ItemType Directory -Force -Path $signingDirectory | Out-Null
$KS_SRC = Join-Path $signingDirectory 'her-local.jks'
$KS = Join-Path $STAGE 'keystore.jks'
$passwordFile = Join-Path $signingDirectory 'password.txt'
if(Test-Path -LiteralPath $passwordFile){$KS_PASS=(Get-Content -Raw -LiteralPath $passwordFile).Trim()}else{$KS_PASS=[Guid]::NewGuid().ToString('N');[System.IO.File]::WriteAllText($passwordFile,$KS_PASS)}
$KS_ALIAS = 'her-local'
$APK_NAME = 'amadeus-debug.apk'

$env:JAVA_HOME = $JAVA_HOME
$env:PATH = (Join-Path $JAVA_HOME 'bin') + ';' + $BT + ';' + $env:PATH

foreach ($p in @($JAVA_HOME, $SDK, $BT, $AJ)) { if (-not (Test-Path $p)) { throw "缺少工具链：$p（先跑 tools\setup-android-toolchain.ps1）" } }

Write-Host '── 0/6 准备 ASCII 构建目录 ──'
if (Test-Path $STAGE) { Remove-Item $STAGE -Recurse -Force }
New-Item -ItemType Directory -Force -Path $STAGE | Out-Null
Copy-Item (Join-Path $HERE 'AndroidManifest.xml') $STAGE -Force
Copy-Item (Join-Path $HERE 'src') (Join-Path $STAGE 'src') -Recurse -Force
Copy-Item (Join-Path $HERE 'res') (Join-Path $STAGE 'res') -Recurse -Force
if (Test-Path (Join-Path $HERE 'assets')) { Copy-Item (Join-Path $HERE 'assets') (Join-Path $STAGE 'assets') -Recurse -Force }
if (Test-Path (Join-Path $HERE 'jniLibs')) { Copy-Item (Join-Path $HERE 'jniLibs') (Join-Path $STAGE 'jniLibs') -Recurse -Force }
if (Test-Path (Join-Path $HERE 'aidl')) { Copy-Item (Join-Path $HERE 'aidl') (Join-Path $STAGE 'aidl') -Recurse -Force }
if (Test-Path (Join-Path $HERE 'libs')) { Copy-Item (Join-Path $HERE 'libs') (Join-Path $STAGE 'libs') -Recurse -Force }
if (Test-Path $KS_SRC) { Copy-Item $KS_SRC $KS -Force }
$BUILD = Join-Path $STAGE 'build'
New-Item -ItemType Directory -Force -Path $BUILD, (Join-Path $BUILD 'gen'), (Join-Path $BUILD 'classes'), (Join-Path $BUILD 'dex') | Out-Null
New-Item -ItemType Directory -Force -Path $DIST | Out-Null

Write-Host '── 1/6 编译资源 (aapt2 compile) ──'
$aapt2 = Join-Path $BT 'aapt2.exe'
$script:assetCount = 0
Push-Location $STAGE
try {
    & $aapt2 compile --dir res -o build\res.zip
    if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }

    Write-Host '── 2/6 链接资源 + 生成 R.java (aapt2 link) ──'
    # ⚠️ 不用 aapt2 的 -A assets：Windows 上它会把条目名写成反斜杠（model\xxx），
    #    AssetManager 就找不到。assets 我们自己用正斜杠写进 zip（见 5/6）。
    $linkArgs = @('link', '-o', 'build\base.apk', '-I', $AJ, '--manifest', 'AndroidManifest.xml',
        '-R', 'build\res.zip', '--java', 'build\gen', '--auto-add-overlay')
    & $aapt2 @linkArgs
    if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }

    # AIDL：Shizuku UserService 的接口（IRunner）要先生成 Java
    if (Test-Path 'aidl') {
        $aidl = Join-Path $BT 'aidl.exe'
        $aidlFiles = @(Get-ChildItem 'aidl' -Recurse -Filter *.aidl | ForEach-Object { $_.FullName })
        if ($aidlFiles) {
            $aidlArgs = @('--lang=java', '-o', (Join-Path $BUILD 'gen'))
            $aidlArgs += @('-I', 'aidl')
            $aidlArgs += $aidlFiles
            & $aidl @aidlArgs
            if ($LASTEXITCODE -ne 0) { throw 'aidl 失败' }
            Write-Host ('   aidl: ' + $aidlFiles.Count + ' 个接口')
        }
    }

    Write-Host '── 3/6 编译 Java (javac) ──'
    $srcs = @(Get-ChildItem 'src' -Recurse -Filter *.java | ForEach-Object { $_.FullName })
    $genSrcs = @(Get-ChildItem 'build\gen' -Recurse -Filter *.java -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    $allSrcs = $srcs + $genSrcs
    # 第三方 jar（Shizuku 的 api/provider）——没有 Gradle，手动进 classpath 和 dex
    $libJars = @(Get-ChildItem 'libs' -Filter *.jar -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    if ($libJars) { Write-Host ("   libs: " + $libJars.Count + " 个 jar") }
    $cp = $AJ
    if ($libJars) { $cp = $AJ + ';' + ($libJars -join ';') }
    $argFile = Join-Path $BUILD 'javac.txt'
    $allSrcs | ForEach-Object { '"' + ($_ -replace '\\', '/') + '"' } | Set-Content $argFile -Encoding ASCII
    & (Join-Path $JAVA_HOME 'bin\javac.exe') -encoding UTF-8 -source 8 -target 8 -nowarn -Xlint:-options `
        -classpath $cp -d (Join-Path $BUILD 'classes') "@$argFile"
    if ($LASTEXITCODE -ne 0) { throw 'javac 失败' }

    Write-Host '── 4/6 生成 dex (d8) ──'
    $classes = @(Get-ChildItem 'build\classes' -Recurse -Filter *.class | ForEach-Object { $_.FullName })
    if (-not $classes) { throw '没有 class 文件' }
    $d8inputs = @($classes)
    if ($libJars) { $d8inputs += $libJars }
    # d8.bat goes through cmd.exe's short command-line limit. An argument file
    # keeps a growing class list and long build paths from breaking packaging.
    $dexArgFile = Join-Path $BUILD 'd8.txt'
    $d8inputs | ForEach-Object { $_ -replace '\\', '/' } | Set-Content $dexArgFile -Encoding ASCII
    & (Join-Path $BT 'd8.bat') --lib $AJ --min-api 26 --release --output 'build\dex' "@$dexArgFile"
    if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }

    Write-Host '── 5/6 打包 + 对齐 ──'
    $baseApk = Join-Path $BUILD 'base.apk'
    $dexFile = Join-Path $BUILD 'dex\classes.dex'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
    $entry = $zip.GetEntry('classes.dex')
    if ($entry) { $entry.Delete() }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dexFile, 'classes.dex',
        [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null

    # assets 自己写进去（正斜杠！），见上面 2/6 的注释
    if (Test-Path 'assets') {
        $assetRoot = (Resolve-Path 'assets').Path
        Get-ChildItem 'assets' -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($assetRoot.Length + 1) -replace '\\', '/'
            $name = 'assets/' + $rel
            $old = $zip.GetEntry($name)
            if ($old) { $old.Delete() }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
            $script:assetCount++
        }
        Write-Host ("   assets: {0} 个文件已写入" -f $script:assetCount)
    }

    # 原生库（Vosk + JNA）：zip 里的路径必须是 lib/<abi>/*.so，且用正斜杠
    if (Test-Path 'jniLibs') {
        $libRoot = (Resolve-Path 'jniLibs').Path
        $script:soCount = 0
        Get-ChildItem 'jniLibs' -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($libRoot.Length + 1) -replace '\\', '/'
            $name = 'lib/' + $rel
            $old = $zip.GetEntry($name)
            if ($old) { $old.Delete() }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name,
                [System.IO.Compression.CompressionLevel]::NoCompression) | Out-Null
            $script:soCount++
        }
        Write-Host ("   原生库: {0} 个 .so 已写入" -f $script:soCount)
    }
    $zip.Dispose()

    $unaligned = Join-Path $BUILD 'unaligned.apk'
    & (Join-Path $BT 'zipalign.exe') -f 4 $baseApk $unaligned
    if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

    Write-Host '── 6/6 签名 (apksigner) ──'
    if (-not (Test-Path $KS)) {
        Write-Host '  生成调试签名…'
        & (Join-Path $JAVA_HOME 'bin\keytool.exe') -genkeypair -keystore $KS -alias $KS_ALIAS `
            -keyalg RSA -keysize 2048 -validity 10000 -storepass $KS_PASS -keypass $KS_PASS `
            -dname 'CN=DaFeiYu, OU=Amadeus, O=Personal, L=Beijing, C=CN'
        if ($LASTEXITCODE -ne 0) { throw 'keytool 失败' }
        Copy-Item $KS $KS_SRC -Force
        Write-Host "  签名已存到 $KS_SRC（以后复用，别删）"
    }
    $outApk = Join-Path $BUILD $APK_NAME
    & (Join-Path $BT 'apksigner.bat') sign --ks $KS --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" `
        --v1-signing-enabled true --v2-signing-enabled true --out $outApk $unaligned
    if ($LASTEXITCODE -ne 0) { throw 'apksigner 失败' }

    $final = Join-Path $DIST $APK_NAME
    if (Test-Path $final) { Remove-Item $final -Force }
    Copy-Item $outApk $final -Force
}
finally {
    Pop-Location
}

$size = [math]::Round((Get-Item (Join-Path $DIST $APK_NAME)).Length / 1KB, 1)
Write-Host ''
Write-Host "✅ 打包完成：$(Join-Path $DIST $APK_NAME)  ($size KB)"
& (Join-Path $BT 'apksigner.bat') verify --print-certs (Join-Path $DIST $APK_NAME) | Select-Object -First 2
