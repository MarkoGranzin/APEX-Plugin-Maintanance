begin
wwv_flow_api.create_plugin(p_id=>1, p_plugin_type=>'REGION', p_name=>'COLORPICKER', p_file_urls=>'https://cdn.example.com/jquery-3.4.1.min.js');
wwv_flow_api.create_plugin_file(p_file_name=>'widget.js', p_file_content=>'YXBleC5pdGVtKCJQMV9DT0xPUiIpLnNldFZhbHVlKCIjZmZmIik7IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ4Iik7');
apex_javascript.add_inline_code(p_code => 'console.log("init colorpicker");');
end;