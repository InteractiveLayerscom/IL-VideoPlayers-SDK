' Launch parameters (deep-link or ECP `launch` query) override pkg:/source/config.json, written by build.sh.
sub main(args as Dynamic)
    config = parseJson(readAsciiFile("pkg:/source/config.json"))
    if type(config) <> "roAssociativeArray" then config = {}
    if type(args) = "roAssociativeArray"
        for each key in ["mode", "consoleOrigin", "relayUrl", "project", "asset", "contentUrl", "breaks"]
            if args[key] <> invalid then config[key] = args[key]
            if key = "breaks" and type(args[key]) = "roString" then config[key] = parseJson(args[key])
        end for
    end if
    screen = createObject("roSGScreen")
    port = createObject("roMessagePort")
    screen.setMessagePort(port)
    scene = screen.createScene("MainScene")
    screen.show()
    scene.config = config
    while true
        message = wait(0, port)
        if type(message) = "roSGScreenEvent" and message.isScreenClosed() then return
    end while
end sub
